// Eigenstaendiger Einstiegspunkt fuer den Scheduler ohne HTTP-Server (z.B. lokales Testen).
// Im normalen Betrieb startet server/index.js den Scheduler direkt mit - ein Railway-Service, ein Prozess.
import { startScheduler } from './scheduler.js';

startScheduler();
