'use strict';

/* =====================================================================
   Levier : moduler une évaluation de voie 2 par un contrôle de voie 1
   Fichier 3/3 : logique (noyau de calcul, interface, exports)
   ===================================================================== */

/* =====================================================================
   1. NOYAU DE CALCUL : pur, sans DOM, testable dans Node
   ===================================================================== */
const Levier = (() => {
  const MOINS = '−';
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  /** Lit un nombre saisi à la française ou à l'anglaise ; NaN si vide ou invalide. */
  function parseNum(v) {
    if (typeof v === 'number') return v;
    if (v === null || v === undefined) return NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(/−/g, '-').replace(',', '.');
    if (s === '') return NaN;
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : NaN;
  }

  const defaut = () => ({
    tasks: [
      { name: 'Production 1', bareme: 20, poids: 30 },
      { name: 'Production 2', bareme: 20, poids: 40 },
      { name: 'Production 3', bareme: 20, poids: 30 },
    ],
    config: {
      echelle: 20, min: 0, arrondi: 0.5,        // échelle de la note finale
      x: 16, ref: 8,                              // contrôle de voie 1 : barème, point neutre / seuil
      mode: 'additif',
      zone: 0, malus: 4, bonus: 4,                // additif
      cmin: 0.8, cmax: 1.1,                       // multiplicatif
      marge: 2,                                   // plafond
      part: 50,                                   // seuil (en %)
      absent: 'neutre',                           // contrôle manquant : 'neutre' | 'zero'
      exemple: 12,                                // note de voie 2 utilisée pour l'aperçu
    },
  });

  /** Les quatre modes, avec leurs explications affichées à l'écran 2. */
  const MODES = {
    additif: {
      titre: 'Bonus / malus en points',
      resume: 'La note de voie 2 monte ou descend d’un nombre de points qui dépend du contrôle.',
      regle: 'Au point neutre (q_réf), rien ne change. En dessous, on retire jusqu’au malus maximal (score 0). Au-dessus, on ajoute jusqu’au bonus maximal (score maximal). Avec un levier symétrique, c’est la formule M + k × (q − q_réf) : malus max = k × q_réf, bonus max = k × (1 − q_réf).',
      usage: 'Le plus lisible pour les élèves : « chaque question de plus ou de moins vaut tant de points ». L’effet est le même quel que soit le niveau en voie 2.',
      attention: 'Un très bon contrôle peut remonter une note de voie 2 faible. Limitez le bonus si ce n’est pas souhaité.',
      formule: 'note finale = M + k × (q − q_réf)   avec M = note de voie 2 et q = score ÷ barème',
      params: ['x', 'ref', 'zone', 'malus', 'bonus'],
    },
    multiplicatif: {
      titre: 'Coefficient de crédibilité',
      resume: 'La note de voie 2 est multipliée par un coefficient lié au contrôle.',
      regle: 'Au point neutre, le coefficient vaut 1. Il descend jusqu’au coefficient minimal (score 0) et monte jusqu’au coefficient maximal (score maximal).',
      usage: 'Quand l’effet doit être proportionnel : une belle production non confirmée perd beaucoup de points, une production modeste en perd peu.',
      attention: 'Moins intuitif à expliquer. Un élève faible en voie 2 ne peut presque rien rattraper.',
      formule: 'note finale = voie 2 × coefficient(contrôle)',
      params: ['x', 'ref', 'zone', 'cmin', 'cmax'],
    },
    plafond: {
      titre: 'Plafond : la voie 2 ne dépasse pas la voie 1',
      resume: 'La note de voie 2 est plafonnée par le résultat du contrôle, plus une marge.',
      regle: 'Le score du contrôle est ramené sur l’échelle de la note finale, puis on ajoute la marge. La note finale est la plus petite des deux valeurs : la voie 2 ou ce plafond.',
      usage: 'Certification stricte : ce que l’élève ne sait pas refaire sans IA n’est pas crédité.',
      attention: 'Ne fait jamais monter une note. Exige un contrôle bien calibré : un contrôle trop difficile écrase toute la classe. Le point neutre n’est pas utilisé.',
      formule: 'note finale = min(voie 2 ; voie 1 ramenée sur l’échelle + marge)',
      params: ['x', 'marge'],
    },
    seuil: {
      titre: 'Seuil de validation',
      resume: 'Le contrôle est validé ou non : la voie 2 compte en totalité ou en partie.',
      regle: 'À partir du seuil, la note de voie 2 est conservée en totalité. Sous le seuil, seule la part conservée est comptée.',
      usage: 'Message binaire et simple : « le contrôle confirme (ou non) ton travail ».',
      attention: 'Effet de falaise : un point d’écart peut faire perdre beaucoup. Prévoir un rattrapage, ou réserver ce mode aux contrôles fiables.',
      formule: 'note finale = voie 2 si contrôle ≥ seuil, sinon voie 2 × part conservée',
      params: ['x', 'ref', 'part'],
    },
  };

  function median(arr) {
    const a = arr.filter(Number.isFinite).sort((p, q) => p - q);
    if (!a.length) return NaN;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** Note de voie 2 sur l'échelle finale. Une saisie vide compte 0 ; NaN si aucune saisie. */
  function noteVoie2(tasks, entries, echelle) {
    let somme = 0, poids = 0, saisies = 0;
    tasks.forEach((t, i) => {
      const p = Number(t.poids) || 0;
      poids += p;
      const v = parseNum(entries[i]);
      if (Number.isFinite(v)) {
        saisies++;
        if (t.bareme > 0) somme += v / t.bareme * p;
      }
    });
    if (saisies === 0 || poids <= 0) return NaN;
    return somme / poids * echelle;
  }

  /** Position du score dans le levier, de -1 (score 0) à +1 (score maximal), 0 dans la zone neutre. */
  function position(s, c) {
    const hi = c.ref + c.zone, lo = c.ref - c.zone;
    let t = 0;
    if (s > hi) t = c.x - hi > 0 ? (s - hi) / (c.x - hi) : 0;
    else if (s < lo) t = lo > 0 ? -(lo - s) / lo : 0;
    return clamp(t, -1, 1);
  }

  /** Note de voie 2 modulée, avant arrondi et bornes. */
  function brut(M, s, c) {
    let sv = s;
    if (!Number.isFinite(sv)) {
      if (c.absent === 'zero') sv = 0; else return M;
    }
    switch (c.mode) {
      case 'additif': {
        const t = position(sv, c);
        return M + (t >= 0 ? c.bonus * t : c.malus * t);
      }
      case 'multiplicatif': {
        const t = position(sv, c);
        return M * (1 + (t >= 0 ? (c.cmax - 1) * t : (1 - c.cmin) * t));
      }
      case 'plafond':
        return Math.min(M, sv / c.x * c.echelle + c.marge);
      case 'seuil':
        return sv >= c.ref ? M : M * c.part / 100;
      default:
        return M;
    }
  }

  function arrondir(n, c) {
    let v = n;
    if (c.arrondi > 0) v = Math.round(v / c.arrondi + 1e-9) * c.arrondi;
    return clamp(v, c.min, c.echelle);
  }

  /** M : note de voie 2 ; s : score de voie 1 (NaN si absent). */
  function calculer(M, s, c) {
    if (!Number.isFinite(M)) return { M, effet: NaN, finale: NaN };
    const n = brut(M, s, c);
    return { M, effet: n - M, finale: arrondir(n, c) };
  }

  /* ---------- mise en forme ---------- */
  /** Arrondi décimal stable (évite 0,725 → 0,72 ou 0,73 selon la représentation flottante). */
  function arrondi(n, d) {
    const f = Math.pow(10, d);
    return Math.sign(n) * Math.round(Math.abs(n) * f + 1e-9) / f;
  }
  const formats = {};
  function fmt(n, max) {
    if (!Number.isFinite(n)) return '—';
    const d = max === undefined ? 2 : max;
    if (!formats[d]) formats[d] = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: d });
    const r = arrondi(n, d);
    return formats[d].format(r === 0 ? 0 : r).replace('-', MOINS);
  }
  function fmtSigne(n) {
    if (!Number.isFinite(n)) return '—';
    const r = arrondi(n, 2);
    if (r === 0) return '0';
    return (r > 0 ? '+' : '') + fmt(r);
  }
  const pluriel = (n, mot) => (Math.abs(n) >= 2 ? mot + 's' : mot);

  /** Texte d'annonce aux élèves, d'après les réglages. */
  function annonce(st) {
    const { tasks, config: c } = st;
    const E = c.echelle, X = c.x, r = c.ref;
    const liste = tasks.map((t) => `${t.name || 'Production'} (${fmt(t.poids, 1)} %)`).join(', ');
    const out = [];
    out.push(`Voie 2 (travail avec IA autorisée) : ${liste}. Ces travaux donnent une note sur ${fmt(E)}.`);
    out.push(`Voie 1 (contrôle sans IA, noté sur ${fmt(X)}) : il vérifie que tu maîtrises ce que tu as produit et module ta note de voie 2.`);
    const hi = r + c.zone, lo = r - c.zone;
    if (c.mode === 'additif') {
      const zoneTxt = c.zone > 0
        ? `Entre ${fmt(lo)} et ${fmt(hi)} sur ${fmt(X)}, ta note ne change pas.`
        : `Avec ${fmt(r)} sur ${fmt(X)}, ta note ne change pas.`;
      const up = X - hi > 0 ? c.bonus / (X - hi) : 0;
      const down = lo > 0 ? c.malus / lo : 0;
      let t = zoneTxt;
      if (up > 0) t += ` Au-dessus, chaque point en plus ajoute ${fmt(up)} ${pluriel(up, 'point')} (jusqu’à +${fmt(c.bonus)}).`;
      if (down > 0) t += ` En dessous, chaque point manquant en retire ${fmt(down)} (jusqu’à ${MOINS}${fmt(c.malus)}).`;
      out.push(t);
    } else if (c.mode === 'multiplicatif') {
      const zoneTxt = c.zone > 0 ? `Entre ${fmt(lo)} et ${fmt(hi)} sur ${fmt(X)}` : `Avec ${fmt(r)} sur ${fmt(X)}`;
      out.push(`${zoneTxt}, ta note de voie 2 est conservée (coefficient 1). Si tu fais mieux, elle est multipliée jusqu’à ${fmt(c.cmax)} pour un score de ${fmt(X)}/${fmt(X)}. Si tu fais moins bien, elle est multipliée jusqu’à ${fmt(c.cmin)} pour un score de 0.`);
    } else if (c.mode === 'plafond') {
      out.push(`Ta note de voie 2 ne peut pas dépasser ton résultat au contrôle ramené sur ${fmt(E)} (${fmt(X)}/${fmt(X)} correspond à ${fmt(E)}), augmenté de ${fmt(c.marge)} ${pluriel(c.marge, 'point')}. Le contrôle peut plafonner ta note, jamais l’augmenter.`);
    } else if (c.mode === 'seuil') {
      out.push(`Si tu obtiens au moins ${fmt(r)} sur ${fmt(X)} au contrôle, ta note de voie 2 compte en totalité. Sinon, elle compte pour ${fmt(c.part)} %.`);
    }
    const arrondiTxt = c.arrondi > 0 ? `arrondie à ${fmt(c.arrondi)} ${pluriel(c.arrondi, 'point')}` : 'non arrondie';
    out.push(`La note finale est ${arrondiTxt} et reste comprise entre ${fmt(c.min)} et ${fmt(E)}.`);
    return out;
  }

  /* ---------- export tableur : classeur avec formules vivantes ---------- */
  function colL(i) {
    let s = '', n = i + 1;
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /**
   * Construit un classeur SheetJS : une feuille « Notes » avec formules vivantes et, à droite, le bloc des paramètres.
   * rows : [{ nom, entries: [nombres ou NaN], v1: nombre ou NaN }]
   * Les valeurs calculées ici sont jointes aux formules (cache) pour les aperçus.
   */
  function construireClasseur(XLSX, st, rows) {
    const { tasks, config: c } = st;
    const n = tasks.length;
    const wb = XLSX.utils.book_new();
    // Colonnes de la feuille unique : élève, productions, voie 1, voie 2, [position], effet, finale, puis le bloc des paramètres.
    const useT = c.mode === 'additif' || c.mode === 'multiplicatif';
    const cV1 = n + 1, cM = n + 2, cT = useT ? n + 3 : -1, cEff = useT ? n + 4 : n + 3, cFin = cEff + 1;
    const pL = cFin + 2, pV = cFin + 3, pR = cFin + 4;      // libellé, valeur, remarque
    // Les paramètres sont dans la même feuille : les références inter-feuilles seraient mal converties en .ods.
    const ref = (l) => `$${colL(pV)}$${l}`;
    const E = ref(3), MIN = ref(4), STEP = ref(5), X = ref(6), R = ref(7), Z = ref(8),
      BM = ref(9), BP = ref(10), CMIN = ref(11), CMAX = ref(12), MARGE = ref(13), PART = ref(14);

    /* --- bloc des paramètres (à droite des notes) --- */
    const utilises = MODES[c.mode].params;
    const lignesP = [
      ['mode', 'Mode de modulation', MODES[c.mode].titre, MODES[c.mode].formule],
      ['echelle', 'Note maximale', c.echelle, ''],
      ['min', 'Note minimale', c.min, ''],
      ['arrondi', 'Arrondi (pas, 0 = aucun)', c.arrondi, ''],
      ['x', 'Barème du contrôle de voie 1', c.x, ''],
      ['ref', c.mode === 'seuil' ? 'Seuil de validation' : 'Point neutre', c.ref, ''],
      ['zone', 'Zone neutre (±, points du contrôle)', c.zone, ''],
      ['malus', 'Malus maximal (points)', c.malus, ''],
      ['bonus', 'Bonus maximal (points)', c.bonus, ''],
      ['cmin', 'Coefficient minimal', c.cmin, ''],
      ['cmax', 'Coefficient maximal', c.cmax, ''],
      ['marge', 'Marge du plafond (points)', c.marge, ''],
      ['part', 'Part conservée sous le seuil', c.part / 100, ''],
      ['absent', 'Contrôle absent', c.absent === 'zero' ? 'compté 0' : 'pas de modulation', 'Fixé à l’export : modifier ce choix demande de réexporter.'],
    ];

    /* --- feuille Notes --- */
    const first = colL(1), last = colL(n);
    const ws = {};
    const put = (r, col, cell) => { ws[XLSX.utils.encode_cell({ r, c: col })] = cell; };
    const S = (v) => ({ t: 's', v });

    put(0, pL, S('Paramètres (modifiables)')); put(0, pV, S('Valeur')); put(0, pR, S('Remarque'));
    lignesP.forEach(([cle, lib, val, rem], i) => {
      put(i + 1, pL, S(lib));
      const cell = typeof val === 'number' ? { t: 'n', v: val } : S(String(val));
      if (cle === 'part') cell.z = '0%';
      put(i + 1, pV, cell);
      let remarque = rem;
      if (!remarque && !['mode', 'echelle', 'min', 'arrondi', 'x'].includes(cle) && !utilises.includes(cle)) remarque = 'Non utilisé avec ce mode.';
      if (remarque) put(i + 1, pR, S(remarque));
    });

    put(0, 0, S('Élève'));
    tasks.forEach((t, i) => put(0, 1 + i, S(t.name || `Production ${i + 1}`)));
    put(0, cV1, S(`Voie 1 (/${c.x})`));
    put(0, cM, S(`Voie 2 (/${c.echelle})`));
    if (useT) put(0, cT, S('Position dans le levier (−1 à +1)'));
    put(0, cEff, S('Effet du contrôle (points)'));
    put(0, cFin, S(`Note finale (/${c.echelle})`));
    put(1, 0, S('Barème de chaque production'));
    tasks.forEach((t, i) => put(1, 1 + i, { t: 'n', v: t.bareme }));
    put(2, 0, S('Poids (sur 100)'));
    tasks.forEach((t, i) => put(2, 1 + i, { t: 'n', v: t.poids }));

    const neutre = c.absent !== 'zero';
    const nums = (x) => (Number.isFinite(x) ? { t: 'n', v: x } : null);

    rows.forEach((row, k) => {
      const R0 = 3 + k;            // index de ligne (0-based) ; ligne Excel = R0 + 1
      const L = R0 + 1;
      put(R0, 0, S(row.nom || `Élève ${k + 1}`));
      row.entries.forEach((v, i) => { const cell = nums(v); if (cell) put(R0, 1 + i, cell); });
      const cell1 = nums(row.v1); if (cell1) put(R0, cV1, cell1);

      const s = `${colL(cV1)}${L}`, M = `${colL(cM)}${L}`, T = `${colL(cT)}${L}`, EFF = `${colL(cEff)}${L}`;
      const res = calculer(noteVoie2(tasks, row.entries, c.echelle), row.v1, c);
      const Mval = res.M;

      // note de voie 2 (formule)
      put(R0, cM, {
        t: 'n', f: `SUMPRODUCT(${first}${L}:${last}${L}/${first}$2:${last}$2,${first}$3:${last}$3)/SUM(${first}$3:${last}$3)*${E}`,
        v: Mval, z: '0.00',
      });

      // position dans le levier
      if (useT) {
        const core = `MAX(-1,MIN(1,IF(${s}>${R}+${Z},IF(${X}-${R}-${Z}>0,(${s}-${R}-${Z})/(${X}-${R}-${Z}),0),IF(${s}<${R}-${Z},IF(${R}-${Z}>0,-(${R}-${Z}-${s})/(${R}-${Z}),0),0))))`;
        const sv = Number.isFinite(row.v1) ? row.v1 : (neutre ? NaN : 0);
        put(R0, cT, { t: 'n', f: neutre ? `IF(${s}="",0,${core})` : core, v: Number.isFinite(sv) ? position(sv, c) : 0, z: '0.00' });
      }

      // effet du contrôle
      let fEff;
      if (c.mode === 'additif') fEff = `${BP}*MAX(${T},0)+${BM}*MIN(${T},0)`;
      else if (c.mode === 'multiplicatif') fEff = `${M}*((${CMAX}-1)*MAX(${T},0)+(1-${CMIN})*MIN(${T},0))`;
      else if (c.mode === 'plafond') {
        const core = `MIN(${M},${s}/${X}*${E}+${MARGE})-${M}`;
        fEff = neutre ? `IF(${s}="",0,${core})` : core;
      } else {
        const core = `IF(${s}>=${R},0,-${M}*(1-${PART}))`;
        fEff = neutre ? `IF(${s}="",0,${core})` : core;
      }
      put(R0, cEff, { t: 'n', f: fEff, v: res.effet, z: '+0.00;-0.00;0' });

      // note finale (arrondie et bornée)
      put(R0, cFin, {
        t: 'n',
        f: `MAX(${MIN},MIN(${E},IF(${STEP}>0,ROUND((${M}+${EFF})/${STEP},0)*${STEP},${M}+${EFF})))`,
        v: res.finale, z: '0.00',
      });
    });

    // moyenne de la classe
    if (rows.length) {
      const rm = 3 + rows.length + 1;
      const a = 4, b = 3 + rows.length;
      put(rm, 0, S('Moyenne de la classe'));
      const moy = (arr) => arr.reduce((p, q) => p + q, 0) / arr.length;
      const resAll = rows.map((row) => calculer(noteVoie2(tasks, row.entries, c.echelle), row.v1, c));
      put(rm, cM, { t: 'n', f: `AVERAGE(${colL(cM)}${a}:${colL(cM)}${b})`, v: moy(resAll.map((x) => x.M)), z: '0.00' });
      put(rm, cFin, { t: 'n', f: `AVERAGE(${colL(cFin)}${a}:${colL(cFin)}${b})`, v: moy(resAll.map((x) => x.finale)), z: '0.00' });
    }

    const lastRow = Math.max(rows.length ? 3 + rows.length + 1 : 3, lignesP.length);
    ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow, c: pR } });
    ws['!cols'] = [{ wch: 28 }, ...tasks.map(() => ({ wch: 16 })), { wch: 14 }, { wch: 14 }, ...(useT ? [{ wch: 18 }] : []), { wch: 18 }, { wch: 16 }, { wch: 3 }, { wch: 36 }, { wch: 26 }, { wch: 60 }];

    XLSX.utils.book_append_sheet(wb, ws, 'Notes');
    return wb;
  }

  return {
    MOINS, clamp, parseNum, defaut, MODES, median, noteVoie2, position, brut, arrondir, calculer,
    fmt, fmtSigne, pluriel, annonce, colL, construireClasseur,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Levier;


/* =====================================================================
   2. INTERFACE
   ===================================================================== */
function demarrerInterface() {
  const L = Levier;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const num2s = (v) => String(v).replace('.', ',');
  const CLE = 'levier.v1';

  /* ---------- état ---------- */
  let state = charger();
  let eleves = [vide(), vide(), vide()];

  function vide() { return { nom: '', notes: state ? state.tasks.map(() => '') : [], v1: '' }; }

  function charger() {
    const d = L.defaut();
    try {
      const raw = localStorage.getItem(CLE);
      if (!raw) return d;
      return fusionner(d, JSON.parse(raw));
    } catch (e) { return d; }
  }
  function fusionner(d, saved) {
    if (!saved || typeof saved !== 'object') return d;
    if (Array.isArray(saved.tasks) && saved.tasks.length) {
      const t = saved.tasks.map((x, i) => ({
        name: typeof x.name === 'string' ? x.name : `Production ${i + 1}`,
        bareme: Number(x.bareme) > 0 ? Number(x.bareme) : 20,
        poids: Number.isFinite(Number(x.poids)) && Number(x.poids) >= 0 ? Number(x.poids) : 0,
      }));
      d.tasks = t;
    }
    if (saved.config && typeof saved.config === 'object') {
      Object.keys(d.config).forEach((k) => {
        if (saved.config[k] !== undefined && typeof saved.config[k] === typeof d.config[k]) d.config[k] = saved.config[k];
      });
      if (!L.MODES[d.config.mode]) d.config.mode = 'additif';
    }
    return d;
  }
  function sauver() {
    try { localStorage.setItem(CLE, JSON.stringify(state)); } catch (e) { /* stockage indisponible : on continue sans */ }
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.id);
    toast.id = setTimeout(() => { t.hidden = true; }, 3200);
  }

  /* ---------- onglets ---------- */
  const PANELS = ['voie2', 'voie1', 'classe'];
  function aller(nom, focusTab) {
    if (!PANELS.includes(nom)) nom = 'voie2';
    PANELS.forEach((p) => {
      const sel = p === nom;
      const tab = $('#tab-' + p);
      tab.setAttribute('aria-selected', sel ? 'true' : 'false');
      tab.tabIndex = sel ? 0 : -1;
      $('#panel-' + p).hidden = !sel;
      if (sel && focusTab) tab.focus();
    });
    if (nom === 'voie1') majApercu();
    if (nom === 'classe') renderClasse();
    try { history.replaceState(null, '', '#' + nom); } catch (e) { /* file:// ou contexte restreint */ }
    window.scrollTo({ top: 0 });
  }
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => aller(tab.dataset.panel));
    tab.addEventListener('keydown', (e) => {
      const i = PANELS.indexOf(tab.dataset.panel);
      if (e.key === 'ArrowRight') { e.preventDefault(); aller(PANELS[(i + 1) % 3], true); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); aller(PANELS[(i + 2) % 3], true); }
    });
  });
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => aller(b.dataset.goto)));

  /* ---------- écran 1 : productions de voie 2 ---------- */
  function renderTasks() {
    $('#tasks-body').innerHTML = state.tasks.map((t, i) => `
      <tr data-i="${i}">
        <td class="idx">${i + 1}</td>
        <td><input type="text" data-k="name" value="${esc(t.name)}" aria-label="Intitulé de la production ${i + 1}" autocomplete="off"></td>
        <td class="num"><input type="text" inputmode="decimal" data-k="bareme" value="${num2s(t.bareme)}" aria-label="Barème de la production ${i + 1}" autocomplete="off"></td>
        <td class="num"><input type="text" inputmode="decimal" data-k="poids" value="${num2s(t.poids)}" aria-label="Poids de la production ${i + 1}" autocomplete="off"></td>
        <td class="act"><button type="button" class="icon" data-del="${i}" aria-label="Supprimer la production ${i + 1}" ${state.tasks.length <= 1 ? 'disabled' : ''}>×</button></td>
      </tr>`).join('');
    majPoids();
  }
  function totalPoids() { return state.tasks.reduce((p, t) => p + (Number(t.poids) || 0), 0); }
  function majPoids() {
    const tot = Math.round(totalPoids() * 1000) / 1000;
    const ok = Math.abs(tot - 100) < 0.005;
    const b = $('#poids-total');
    b.textContent = `${L.fmt(tot)} / 100`;
    b.className = 'badge ' + (ok ? 'ok' : 'bad');
    const msg = $('#poids-msg');
    if (ok) msg.textContent = 'Le total fait bien 100.';
    else if (tot < 100) msg.textContent = `Il manque ${L.fmt(100 - tot)} pour atteindre 100. Les notes seront tout de même calculées proportionnellement.`;
    else msg.textContent = `Le total dépasse 100 de ${L.fmt(tot - 100)}. Les notes seront tout de même calculées proportionnellement.`;
  }
  $('#tasks-body').addEventListener('input', (e) => {
    const el = e.target, tr = el.closest('tr');
    if (!tr || !el.dataset.k) return;
    const i = Number(tr.dataset.i), k = el.dataset.k;
    if (k === 'name') state.tasks[i].name = el.value;
    else {
      const v = L.parseNum(el.value);
      const ok = Number.isFinite(v) && (k === 'bareme' ? v > 0 : v >= 0);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      state.tasks[i][k] = v;
    }
    majPoids(); sauver();
  });
  $('#tasks-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (!b || state.tasks.length <= 1) return;
    const i = Number(b.dataset.del);
    state.tasks.splice(i, 1);
    eleves.forEach((s) => s.notes.splice(i, 1));
    renderTasks(); sauver();
  });
  $('#task-add').addEventListener('click', () => {
    const reste = Math.max(0, Math.round((100 - totalPoids()) * 100) / 100);
    state.tasks.push({ name: `Production ${state.tasks.length + 1}`, bareme: 20, poids: reste });
    eleves.forEach((s) => s.notes.push(''));
    renderTasks(); sauver();
    const inputs = $$('#tasks-body input[data-k="name"]');
    inputs[inputs.length - 1].focus();
  });
  $('#task-equal').addEventListener('click', () => {
    const n = state.tasks.length;
    const base = Math.floor(10000 / n) / 100;
    state.tasks.forEach((t, i) => { t.poids = i === n - 1 ? Math.round((100 - base * (n - 1)) * 100) / 100 : base; });
    renderTasks(); sauver();
  });
  $('#task-normalize').addEventListener('click', () => {
    const tot = totalPoids();
    if (tot <= 0) return;
    let acc = 0;
    state.tasks.forEach((t, i) => {
      if (i === state.tasks.length - 1) t.poids = Math.round((100 - acc) * 100) / 100;
      else { t.poids = Math.round(t.poids / tot * 10000) / 100; acc += t.poids; }
    });
    renderTasks(); sauver();
  });

  /* ---------- champs de réglage génériques (data-cfg) ---------- */
  const VALID = {
    echelle: (v) => v > 0, min: (v) => v >= 0 && v < state.config.echelle, arrondi: (v) => v >= 0,
    x: (v) => v > 0, ref: (v) => v >= 0, zone: (v) => v >= 0, malus: (v) => v >= 0, bonus: (v) => v >= 0,
    cmin: (v) => v > 0, cmax: (v) => v > 0, marge: (v) => v >= 0, part: (v) => v >= 0 && v <= 100,
    exemple: (v) => v >= 0,
  };
  function afficherChamps() {
    $$('[data-cfg]').forEach((el) => {
      if (document.activeElement === el) return;
      const v = String(state.config[el.dataset.cfg]);
      el.value = el.tagName === 'SELECT' ? v : num2s(v);
      el.classList.remove('invalid');
    });
    $('#select-absent').value = state.config.absent;
  }
  $$('[data-cfg]').forEach((el) => {
    el.addEventListener('input', () => {
      const key = el.dataset.cfg;
      const v = L.parseNum(el.value);
      const ok = Number.isFinite(v) && (VALID[key] ? VALID[key](v) : true);
      el.classList.toggle('invalid', !ok);
      if (!ok) return;
      state.config[key] = v;
      sauver(); majApercu(); majVoie1Msg();
      if (!$('#panel-classe').hidden) majClasse();
    });
    el.addEventListener('blur', afficherChamps);
  });
  /* ---------- levier symétrique : k relié au malus et au bonus maximaux ---------- */
  const qRef = () => L.clamp(state.config.ref / state.config.x, 0, 1);
  const arr2 = (v) => Math.round(v * 100) / 100;
  function majK() {
    const c = state.config, q = qRef(), kIn = $('#k-input');
    const kMalus = q > 0 ? c.malus / q : NaN, kBonus = q < 1 ? c.bonus / (1 - q) : NaN;
    const sym = Number.isFinite(kMalus) && Number.isFinite(kBonus) && Math.abs(kMalus - kBonus) < 0.02;
    if (document.activeElement !== kIn) { kIn.value = sym ? num2s(arr2(kMalus)) : ''; kIn.classList.remove('invalid'); }
    $('#k-hint').textContent = sym
      ? `Levier symétrique : M + k × (q − q_réf), avec q_réf = ${L.fmt(q, 3)} (point neutre ÷ barème). Modifier k règle le malus et le bonus.`
      : 'Levier asymétrique : le malus et le bonus ne correspondent pas à un seul k. Saisissez k pour revenir à la formule M + k × (q − q_réf).';
  }
  $('#k-input').addEventListener('input', (e) => {
    const k = L.parseNum(e.target.value), q = qRef();
    const ok = Number.isFinite(k) && k >= 0;
    e.target.classList.toggle('invalid', !ok);
    if (!ok) return;
    state.config.malus = arr2(k * q);
    state.config.bonus = arr2(k * (1 - q));
    sauver(); afficherChamps(); majApercu(); majVoie1Msg();
    if (!$('#panel-classe').hidden) majClasse();
  });
  $('#k-input').addEventListener('blur', majK);

  $('#select-absent').addEventListener('change', (e) => {
    state.config.absent = e.target.value; sauver(); majClasse(); majApercu();
  });

  /* ---------- écran 2 : cartes de modes ---------- */
  function renderModes() {
    $('#mode-cards').innerHTML = Object.entries(L.MODES).map(([id, m], i) => `
      <label class="mode-card" data-mode="${id}">
        <input type="radio" name="mode" value="${id}" class="sr-only">
        <span class="mode-num">Mode ${i + 1}</span>
        <strong class="mode-title">${esc(m.titre)}</strong>
        <span class="mode-sum">${esc(m.resume)}</span>
        <dl>
          <dt>Règle</dt><dd>${esc(m.regle)}</dd>
          <dt>Quand l’utiliser</dt><dd>${esc(m.usage)}</dd>
          <dt>À savoir</dt><dd>${esc(m.attention)}</dd>
        </dl>
        <code class="formule">${esc(m.formule)}</code>
      </label>`).join('');
    $$('#mode-cards input').forEach((r) => r.addEventListener('change', () => {
      state.config.mode = r.value; sauver(); majMode(); majApercu(); majVoie1Msg();
      if (!$('#panel-classe').hidden) majClasse();
    }));
  }
  function majMode() {
    const mode = state.config.mode;
    $$('#mode-cards .mode-card').forEach((card) => {
      const sel = card.dataset.mode === mode;
      card.classList.toggle('selected', sel);
      $('input', card).checked = sel;
    });
    $$('[data-modes]').forEach((f) => { f.hidden = !f.dataset.modes.split(' ').includes(mode); });
    $('#ref-label').textContent = mode === 'seuil' ? 'Seuil de validation' : 'Point neutre';
    $('#ref-hint').textContent = mode === 'seuil'
      ? 'Score minimal pour que la voie 2 compte en totalité.'
      : 'Score pour lequel la note de voie 2 ne change pas.';
  }
  function majVoie1Msg() {
    const c = state.config, msgs = [];
    if (c.ref > c.x && c.mode !== 'plafond') msgs.push('Le point neutre dépasse le barème du contrôle.');
    if (c.mode !== 'plafond' && c.mode !== 'seuil' && c.zone > Math.min(c.ref, c.x - c.ref)) msgs.push('La zone neutre est plus large que l’écart entre le point neutre et une extrémité du contrôle : un côté du levier n’aura aucun effet.');
    if (c.mode === 'multiplicatif' && c.cmin > 1) msgs.push('Le coefficient minimal dépasse 1 : un mauvais contrôle augmenterait la note.');
    if (c.mode === 'multiplicatif' && c.cmax < 1) msgs.push('Le coefficient maximal est inférieur à 1 : un bon contrôle baisserait la note.');
    $('#voie1-msg').textContent = msgs.join(' ');
  }

  /* ---------- écran 2 : aperçu (courbe, tableau, annonce) ---------- */
  function lignesApercu() {
    const c = state.config;
    const M = Math.min(c.exemple, c.echelle);
    const pts = [];
    if (Number.isInteger(c.x) && c.x <= 40) { for (let s = 0; s <= c.x; s++) pts.push(s); }
    else { for (let i = 0; i <= 20; i++) pts.push(Math.round(c.x * i / 20 * 10) / 10); }
    return pts.map((s) => ({ s, ...L.calculer(M, s, c) }));
  }
  function courbeSVG() {
    const c = state.config;
    const M = Math.min(c.exemple, c.echelle);
    const W = 560, H = 300, ml = 46, mr = 16, mt = 16, mb = 44;
    const px = (s) => ml + (s / c.x) * (W - ml - mr);
    const lo = c.min, hi = c.echelle;
    const py = (v) => H - mb - ((v - lo) / (hi - lo)) * (H - mt - mb);
    const cfg = { ...c, arrondi: 0 };
    const N = 200, pts = [];
    for (let i = 0; i <= N; i++) {
      const s = c.x * i / N;
      const f = L.calculer(M, s, cfg).finale;
      pts.push(`${px(s).toFixed(1)},${py(f).toFixed(1)}`);
    }
    const yt = [];
    for (let i = 0; i <= 4; i++) yt.push(lo + (hi - lo) * i / 4);
    const xt = [];
    const stepX = c.x <= 20 ? (c.x <= 10 ? 1 : 2) : c.x / 5;
    for (let s = 0; s <= c.x + 1e-9; s += stepX) xt.push(s);
    const showRef = c.mode !== 'plafond';
    let g = '';
    yt.forEach((v) => { g += `<line class="grid-line" x1="${ml}" x2="${W - mr}" y1="${py(v)}" y2="${py(v)}"/><text class="tick" x="${ml - 8}" y="${py(v) + 4}" text-anchor="end">${L.fmt(v, 1)}</text>`; });
    xt.forEach((s) => { g += `<text class="tick" x="${px(s)}" y="${H - mb + 18}" text-anchor="middle">${L.fmt(s, 1)}</text>`; });
    if (showRef) {
      g += `<line class="ref-line" x1="${px(c.ref)}" x2="${px(c.ref)}" y1="${mt}" y2="${H - mb}"/>`;
      g += `<text class="ref-text" x="${px(c.ref) + 6}" y="${mt + 12}">${c.mode === 'seuil' ? 'seuil' : 'neutre'}</text>`;
    }
    g += `<line class="base-line" x1="${ml}" x2="${W - mr}" y1="${py(M)}" y2="${py(M)}"/>`;
    g += `<text class="base-text" x="${W - mr}" y="${py(M) - 6}" text-anchor="end">note de voie 2 : ${L.fmt(M)}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" class="chart" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      ${g}
      <line class="axis" x1="${ml}" x2="${W - mr}" y1="${H - mb}" y2="${H - mb}"/>
      <line class="axis" x1="${ml}" x2="${ml}" y1="${mt}" y2="${H - mb}"/>
      <polyline class="curve" points="${pts.join(' ')}"/>
      <text class="axis-title" x="${(ml + W - mr) / 2}" y="${H - 6}" text-anchor="middle">Score au contrôle de voie 1 (sur ${L.fmt(c.x)})</text>
      <text class="axis-title" transform="translate(12 ${(mt + H - mb) / 2}) rotate(-90)" text-anchor="middle">Note finale</text>
    </svg>`;
  }
  function majApercu() {
    const c = state.config;
    majK();
    $('#chart').innerHTML = courbeSVG();
    $('#preview-body').innerHTML = lignesApercu().map((r) => {
      const neutre = r.s === c.ref ? ' class="is-ref"' : '';
      const cls = r.effet > 0.004 ? 'pos' : (r.effet < -0.004 ? 'neg' : '');
      return `<tr${neutre}><td class="num">${L.fmt(r.s, 1)}</td><td class="num ${cls}">${L.fmtSigne(r.effet)}</td><td class="num"><strong>${L.fmt(r.finale)}</strong></td></tr>`;
    }).join('');
    $('#annonce-text').innerHTML = L.annonce(state).map((p) => `<p>${esc(p)}</p>`).join('');
    const med = L.median(eleves.map((s) => L.parseNum(s.v1)));
    const b = $('#btn-median');
    b.disabled = !Number.isFinite(med);
    $('#median-info').textContent = Number.isFinite(med) ? `Médiane saisie dans l’onglet Classe : ${L.fmt(med)} sur ${L.fmt(c.x)}.` : 'Saisissez des scores dans l’onglet Classe pour proposer la médiane.';
  }
  $('#btn-median').addEventListener('click', () => {
    const med = L.median(eleves.map((s) => L.parseNum(s.v1)));
    if (!Number.isFinite(med)) return;
    state.config.ref = Math.round(med * 2) / 2;
    sauver(); afficherChamps(); majApercu(); majVoie1Msg();
    toast(`Point neutre réglé sur ${L.fmt(state.config.ref)}.`);
  });
  $('#btn-copy-annonce').addEventListener('click', () => copier(L.annonce(state).join('\n\n'), 'Texte copié.'));

  /* ---------- écran 3 : classe ---------- */
  function normaliserEleves() {
    const n = state.tasks.length;
    eleves.forEach((s) => { while (s.notes.length < n) s.notes.push(''); s.notes.length = n; });
  }
  function renderClasse() {
    normaliserEleves();
    const c = state.config;
    $('#class-head').innerHTML = `<tr><th>Élève</th>${state.tasks.map((t) => `<th class="num">${esc(t.name)}<small>/ ${L.fmt(t.bareme)}</small></th>`).join('')}
      <th class="num col-v1">Voie 1<small>/ ${L.fmt(c.x)}</small></th>
      <th class="num">Voie 2<small>/ ${L.fmt(c.echelle)}</small></th><th class="num">Effet</th>
      <th class="num">Note finale<small>/ ${L.fmt(c.echelle)}</small></th><th><span class="sr-only">Actions</span></th></tr>`;
    $('#class-body').innerHTML = eleves.map((s, i) => `
      <tr data-i="${i}">
        <td><input type="text" data-f="nom" value="${esc(s.nom)}" placeholder="Nom ou identifiant" aria-label="Élève ${i + 1}" autocomplete="off"></td>
        ${state.tasks.map((t, j) => `<td class="num"><input type="text" inputmode="decimal" data-f="note" data-j="${j}" value="${esc(s.notes[j])}" aria-label="${esc(t.name)}, élève ${i + 1}" autocomplete="off"></td>`).join('')}
        <td class="num col-v1"><input type="text" inputmode="decimal" data-f="v1" value="${esc(s.v1)}" aria-label="Voie 1, élève ${i + 1}" autocomplete="off"></td>
        <td class="num calc" data-c="M"></td><td class="num calc" data-c="effet"></td><td class="num calc fin" data-c="fin"></td>
        <td class="act"><button type="button" class="icon" data-del="${i}" aria-label="Supprimer l’élève ${i + 1}">×</button></td>
      </tr>`).join('');
    $('#paste-help').textContent = `Colonnes attendues : Élève (facultatif), ${state.tasks.map((t) => t.name || 'production').join(', ')}, puis Voie 1. Les virgules décimales sont acceptées ; une ligne d’en-tête est ignorée.`;
    $('#select-absent').value = c.absent;
    majClasse();
  }
  function resultat(s) {
    const M = L.noteVoie2(state.tasks, s.notes, state.config.echelle);
    return L.calculer(M, L.parseNum(s.v1), state.config);
  }
  function majLigne(tr) {
    const i = Number(tr.dataset.i), s = eleves[i], c = state.config;
    const r = resultat(s);
    $('[data-c="M"]', tr).textContent = L.fmt(r.M);
    const e = $('[data-c="effet"]', tr);
    e.textContent = L.fmtSigne(r.effet);
    e.className = 'num calc ' + (r.effet > 0.004 ? 'pos' : (r.effet < -0.004 ? 'neg' : ''));
    const f = $('[data-c="fin"]', tr);
    f.textContent = L.fmt(r.finale);
    const borne = Number.isFinite(r.finale) && (r.finale <= c.min || r.finale >= c.echelle) && Math.abs(r.M + r.effet - r.finale) > 0.004;
    f.className = 'num calc fin' + (borne ? ' borne' : '');
    f.title = borne ? 'Note ramenée à la borne de l’échelle' : '';
    return { r, borne };
  }
  function majClasse() {
    const rows = $$('#class-body tr').map((tr) => ({ ...majLigne(tr) }));
    const ok = rows.filter((x) => Number.isFinite(x.r.finale));
    const moy = (a) => (a.length ? a.reduce((p, q) => p + q, 0) / a.length : NaN);
    const mM = moy(ok.map((x) => x.r.M)), mF = moy(ok.map((x) => x.r.finale));
    // sens de la modulation : l'effet du contrôle, sauf si la note a été bornée (on compare alors à la note de voie 2)
    const delta = (x) => (x.borne ? x.r.finale - x.r.M : x.r.effet);
    const monte = ok.filter((x) => delta(x) > 0.004).length;
    const baisse = ok.filter((x) => delta(x) < -0.004).length;
    const borne = ok.filter((x) => x.borne).length;
    const med = L.median(eleves.map((s) => L.parseNum(s.v1)));
    const c = state.config;
    const carte = (lib, val, sous) => `<div class="stat"><span>${lib}</span><b>${val}</b>${sous ? `<small>${sous}</small>` : ''}</div>`;
    let avert = '';
    if (ok.length && Math.abs(mF - mM) > 0.5) avert = `Le levier ${mF > mM ? 'relève' : 'abaisse'} la moyenne de ${L.fmt(Math.abs(mF - mM))} point(s). Si ce n’est pas voulu, recalez le point neutre sur la médiane du contrôle.`;
    $('#stats').innerHTML =
      carte('Élèves notés', ok.length, '') +
      carte('Moyenne voie 2', L.fmt(mM), `sur ${L.fmt(c.echelle)}`) +
      carte('Moyenne finale', L.fmt(mF), ok.length ? `écart ${L.fmtSigne(mF - mM)}` : '') +
      carte('Notes qui montent', monte, `${baisse} baissent · ${ok.length - monte - baisse} inchangées`) +
      carte('Bornées', borne, 'ramenées à 0 ou au maximum') +
      carte('Médiane contrôle', L.fmt(med), `sur ${L.fmt(c.x)}`) +
      (avert ? `<p class="stat-warn" role="status">${esc(avert)}</p>` : '');
    const incomplets = eleves.filter((s) => s.notes.some((v) => v !== '') || s.v1 !== '').length - ok.length;
    $('#export-note').textContent = incomplets > 0 ? `${incomplets} ligne(s) sans note de voie 2 ne seront pas exportées.` : '';
  }
  $('#class-body').addEventListener('input', (e) => {
    const el = e.target, tr = el.closest('tr');
    if (!tr) return;
    const s = eleves[Number(tr.dataset.i)];
    if (el.dataset.f === 'nom') { s.nom = el.value; return; }
    let max = Infinity, bad = false;
    const v = L.parseNum(el.value);
    if (el.dataset.f === 'note') { s.notes[Number(el.dataset.j)] = el.value; max = state.tasks[Number(el.dataset.j)].bareme; }
    if (el.dataset.f === 'v1') { s.v1 = el.value; max = state.config.x; }
    if (el.value.trim() !== '') bad = !Number.isFinite(v) || v < 0 || v > max;
    el.classList.toggle('invalid', bad);
    el.title = bad ? `Valeur attendue entre 0 et ${L.fmt(max)}` : '';
    majLigne(tr); majClasse();
  });
  $('#class-body').addEventListener('click', (e) => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    eleves.splice(Number(b.dataset.del), 1);
    if (!eleves.length) eleves.push(vide());
    renderClasse();
  });
  $('#btn-add-student').addEventListener('click', () => {
    eleves.push(vide()); renderClasse();
    const rows = $$('#class-body tr'); $('input', rows[rows.length - 1]).focus();
  });
  $('#btn-add-5').addEventListener('click', () => { for (let i = 0; i < 5; i++) eleves.push(vide()); renderClasse(); });
  $('#btn-clear-students').addEventListener('click', () => {
    if (eleves.some((s) => s.nom || s.v1 || s.notes.some(Boolean)) && !confirm('Vider la liste des élèves ?')) return;
    eleves = [vide(), vide(), vide()]; renderClasse();
  });

  /* ---------- collage depuis un tableur ---------- */
  function analyserCollage(texte) {
    const n = state.tasks.length;
    const lignes = texte.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
    let cells = lignes.map((l) => (l.includes('\t') ? l.split('\t') : l.split(';')).map((x) => x.trim()));
    const avecNom = cells.some((r) => r[0] !== '' && r[0] !== undefined && !Number.isFinite(L.parseNum(r[0])));
    const off = avecNom ? 1 : 0;
    // en-tête : une ligne dont une cellule de note est non vide et non numérique
    cells = cells.filter((r) => !r.slice(off, off + n + 1).some((x) => x !== '' && !Number.isFinite(L.parseNum(x))));
    return cells.map((r) => ({
      nom: avecNom ? (r[0] || '') : '',
      notes: Array.from({ length: n }, (_, j) => r[off + j] || ''),
      v1: r[off + n] || '',
    }));
  }
  $('#btn-paste-import').addEventListener('click', () => {
    const lignes = analyserCollage($('#paste-text').value);
    const msg = $('#paste-msg');
    if (!lignes.length) { msg.textContent = 'Aucune ligne reconnue.'; return; }
    const remplacer = $('input[name="paste-mode"]:checked').value === 'replace';
    eleves = remplacer ? lignes : eleves.filter((s) => s.nom || s.v1 || s.notes.some(Boolean)).concat(lignes);
    $('#paste-text').value = '';
    msg.textContent = `${lignes.length} ligne(s) importée(s).`;
    renderClasse();
  });

  /* ---------- exports ---------- */
  function lignesExport() {
    return eleves
      .map((s) => ({ nom: s.nom, entries: s.notes.map((v) => L.parseNum(v)), v1: L.parseNum(s.v1), res: resultat(s) }))
      .filter((r) => Number.isFinite(r.res.M));
  }
  function nombreTexte(x, dec) {
    if (!Number.isFinite(x)) return '';
    return String(Math.round(x * 100) / 100).replace('.', dec);
  }
  function tableauTexte(sep, dec, quote) {
    const c = state.config;
    const q = (t) => (quote && /[;"\n\t]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t);
    const head = ['Élève', ...state.tasks.map((t) => t.name), `Voie 1 (/${nombreTexte(c.x, dec)})`, `Voie 2 (/${nombreTexte(c.echelle, dec)})`, 'Effet du contrôle', `Note finale (/${nombreTexte(c.echelle, dec)})`];
    const lignes = [head.map(q).join(sep)];
    lignesExport().forEach((r) => {
      lignes.push([q(r.nom), ...r.entries.map((v) => nombreTexte(v, dec)), nombreTexte(r.v1, dec), nombreTexte(r.res.M, dec), nombreTexte(r.res.effet, dec), nombreTexte(r.res.finale, dec)].join(sep));
    });
    return lignes.join('\r\n');
  }
  const dec = () => $('#sel-decimal').value;
  const horodatage = () => new Date().toISOString().slice(0, 10);
  function telecharger(blob, nom) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = nom;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function copier(texte, message) {
    const fin = () => toast(message);
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(texte).then(fin, () => repli());
    } else repli();
    function repli() {
      const ta = document.createElement('textarea');
      ta.value = texte; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); fin(); } catch (e) { toast('Copie impossible : sélectionnez le texte à la main.'); }
      ta.remove();
    }
  }
  function verifierExport() {
    if (!lignesExport().length) { toast('Aucune ligne à exporter : saisissez au moins une note de voie 2.'); return false; }
    return true;
  }
  $('#btn-csv').addEventListener('click', () => {
    if (!verifierExport()) return;
    telecharger(new Blob(['﻿' + tableauTexte(';', dec(), true)], { type: 'text/csv;charset=utf-8' }), `notes_modulees_${horodatage()}.csv`);
  });
  $('#btn-copy').addEventListener('click', () => {
    if (!verifierExport()) return;
    copier(tableauTexte('\t', dec(), false), 'Tableau copié : collez-le dans votre tableur.');
  });
  function exporterClasseur(format) {
    if (!verifierExport()) return;
    if (!window.XLSX) { toast('La bibliothèque d’export n’a pas pu se charger (connexion ?). Utilisez le CSV ou la copie.'); return; }
    const rows = lignesExport().map(({ nom, entries, v1 }) => ({ nom, entries, v1 }));
    const wb = L.construireClasseur(window.XLSX, state, rows);
    const data = window.XLSX.write(wb, { bookType: format, type: 'array' });
    const mime = format === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.oasis.opendocument.spreadsheet';
    telecharger(new Blob([data], { type: mime }), `notes_modulees_${horodatage()}.${format}`);
  }
  $('#btn-xlsx').addEventListener('click', () => exporterClasseur('xlsx'));
  $('#btn-ods').addEventListener('click', () => exporterClasseur('ods'));

  /* ---------- configuration : enregistrer, charger, réinitialiser ---------- */
  $('#btn-save-config').addEventListener('click', () => {
    const json = JSON.stringify({ levier: 1, tasks: state.tasks, config: state.config }, null, 2);
    telecharger(new Blob([json], { type: 'application/json' }), `levier_configuration_${horodatage()}.json`);
  });
  $('#btn-load-config').addEventListener('click', () => $('#file-config').click());
  $('#file-config').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (!f) return;
    f.text().then((t) => {
      const data = JSON.parse(t);
      state = fusionner(L.defaut(), data);
      sauver(); toutRafraichir(); toast('Configuration chargée.');
    }).catch(() => toast('Ce fichier n’est pas une configuration Levier valide.'));
    e.target.value = '';
  });
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('Revenir aux réglages par défaut ? Les productions et réglages actuels seront perdus.')) return;
    state = L.defaut(); eleves = [vide(), vide(), vide()];
    sauver(); toutRafraichir();
  });

  function toutRafraichir() {
    normaliserEleves();
    renderTasks(); afficherChamps(); majMode(); majApercu(); majVoie1Msg();
    if (!$('#panel-classe').hidden) renderClasse();
  }

  /* ---------- démarrage ---------- */
  renderModes();
  eleves = [vide(), vide(), vide()];
  toutRafraichir();
  aller((location.hash || '').replace('#', '') || 'voie2');
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', demarrerInterface);
  else demarrerInterface();
}
