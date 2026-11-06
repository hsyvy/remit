import { config } from "../src/config.ts";
import { newId, openDb, tx } from "../src/db.ts";

/**
 * Adds four closed example weeks so the agent has spending history to plan from.
 * They are marked source = 'seed' and hold no PayPal money.  Run: npm run seed
 */

const db = openDb(config.dbPath);
if (db.prepare("SELECT 1 FROM periods WHERE source = 'seed' LIMIT 1").get()) {
  console.log("Example history is already there.");
  process.exit(0);
}

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

const weeks: { start: number; buys: [number, string, string, number][] }[] = [
  {
    start: -28,
    buys: [
      [-27, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4410],
      [-24, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4290],
      [-23, "household", "Laundry Detergent, 96 loads", 1999],
    ],
  },
  {
    start: -21,
    buys: [
      [-21, "dog-food", "Adult Chicken & Rice Dry Dog Food, 12 kg bag", 3249],
      [-20, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4520],
      [-17, "groceries", "Pantry restock: rice, pasta, oil, canned beans", 4180],
    ],
  },
  {
    start: -14,
    buys: [
      [-13, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4335],
      [-10, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4460],
      [-9, "household", "Paper Towels, 12 Double Rolls", 2299],
    ],
  },
  {
    start: -7,
    buys: [
      [-6, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4270],
      [-3, "groceries", "Weekly grocery order: produce, dairy, bread, eggs", 4495],
      [-2, "coffee", "Whole Bean Coffee, Medium Roast, 1 kg", 2450],
    ],
  },
];

const labels: Record<string, string> = { groceries: "Groceries", "dog-food": "Dog food", household: "Household", coffee: "Coffee" };

tx(db, () => {
  for (const week of weeks) {
    const periodId = newId("per");
    const ended = day(week.start + 6);
    db.prepare("INSERT INTO periods (id, summary, starts_on, ends_on, status, source, created_at, closed_at) VALUES (?, ?, ?, ?, 'closed', 'seed', ?, ?)")
      .run(periodId, "Example week (seeded)", day(week.start), ended, `${day(week.start)}T09:00:00.000Z`, `${ended}T23:00:00.000Z`);
    const spentByLine = new Map<string, number>();
    for (const [, line, , cents] of week.buys) spentByLine.set(line, (spentByLine.get(line) ?? 0) + cents);
    const envelopeIds = new Map<string, string>();
    for (const [line, spent] of spentByLine) {
      const id = newId("env");
      envelopeIds.set(line, id);
      db.prepare("INSERT INTO envelopes (id, period_id, line_key, label, reason, limit_cents) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, periodId, line, labels[line], "Seeded example", Math.ceil((spent * 1.1) / 100) * 100);
    }
    for (const [offset, line, title, cents] of week.buys) {
      db.prepare(
        `INSERT INTO purchases (id, period_id, envelope_id, line_key, status, amount_cents, from_line_cents, title, merchant, reasoning, agent, created_at)
         VALUES (?, ?, ?, ?, 'captured', ?, ?, ?, 'demo catalog', 'Seeded example purchase', 'remit', ?)`,
      ).run(newId("pur"), periodId, envelopeIds.get(line)!, line, cents, cents, title, `${day(offset)}T15:00:00.000Z`);
    }
  }
});
console.log("Added 4 example weeks of history.");
