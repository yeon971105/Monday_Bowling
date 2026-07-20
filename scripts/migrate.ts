import { closeDb, getDb } from "../src/lib/db";

getDb();
closeDb();
console.log("SQLite schema is current.");
