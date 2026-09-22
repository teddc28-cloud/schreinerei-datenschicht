import { getParameterNumber } from '../../db/parameters.js';
import { getAktiveProjekteStunden } from './aktiveProjekteStunden.js';

/**
 * 5.5 Projektampeln (Aggregat) - nur Stunden-Ampel.
 * Die Material-Ampel wird bewusst weggelassen: Hero liefert keine projektbezogenen
 * Ist-Materialkosten (Pflichtenheft 8.1, "Empfehlung: Variante 1 zum Start").
 */
export async function getProjektampelnKachel() {
  const schwelleRot = await getParameterNumber('ampel_schwelle_rot', 110);
  const { anzahl_laufend, projekte } = await getAktiveProjekteStunden();

  const ergebnisse = projekte
    .map((p) => ({ ...p, rot: p.prozent >= schwelleRot }))
    .sort((a, b) => b.prozent - a.prozent);

  const top = ergebnisse.slice(0, 5);
  const flop = ergebnisse.slice(-5).reverse();

  return {
    schwelle_rot_prozent: schwelleRot,
    anzahl_laufend,
    anzahl_mit_soll_basis: ergebnisse.length,
    top,
    flop,
  };
}
