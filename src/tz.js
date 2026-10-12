// Muss als ERSTER Import geladen werden (vor jedem Date-Zugriff).
// Railway-Container laufen in UTC. Monatsgrenzen, Kalenderwochen und Zeitfenster sind fachlich
// deutsche Ortszeit – sonst verschieben sich z. B. am Monatsersten 00:00–02:00 die Fenster.
// APP_TZ erlaubt eine bewusste Abweichung (Tests); TZ der Umgebung wird absichtlich überschrieben.
import 'dotenv/config'; // damit APP_TZ auch aus einer lokalen .env wirkt
export const APP_TZ = process.env.APP_TZ || 'Europe/Berlin';
process.env.TZ = APP_TZ;
