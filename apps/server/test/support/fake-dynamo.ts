import { Readable } from "node:stream";

// The in-memory DynamoDB the story and approval tests share. It evaluates the condition and update expressions the stores send,
// applies a transaction all-or-nothing, and can run a hook just before a transaction (to simulate a concurrent write).

export const STORIES = "haunt-user-stories";
export const APPROVALS = "haunt-story-approvals";

type Row = Record<string, any>;
const GSI: Record<string, Record<string, [string, string]>> = {
  [STORIES]: { "published-by-date": ["publishedKey", "publishedAt"] },
  [APPROVALS]: {
    "status-submitted": ["status", "submittedAt"],
    "creator-submitted": ["submittedBy", "submittedAt"],
    "story-submitted": ["storyId", "submittedAt"],
  },
};
const KEYS: Record<string, [string, string | undefined]> = {
  [STORIES]: ["userId", "hauntId"],
  [APPROVALS]: ["submissionId", undefined],
};

export function fakeDynamo() {
  /** Runs once, just before the next transaction is evaluated. Used to simulate a concurrent write. */
  const hooks: { beforeTransact?: () => void } = {};
  const tables = new Map<string, Map<string, Row>>([
    [STORIES, new Map()],
    [APPROVALS, new Map()],
  ]);
  const keyOf = (table: string, item: Row) => {
    const [h, r] = KEYS[table]!;
    return r ? `${item[h]}|${item[r]}` : String(item[h]);
  };
  const names = (input: Row, text: string) => text.replace(/#\w+/g, (n) => input.ExpressionAttributeNames?.[n] ?? n);
  const value = (input: Row, token: string) => input.ExpressionAttributeValues?.[token];
  const fail = () => Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });

  /** Evaluates a condition (attribute_not_exists or attr = :value, joined by AND) against an item. */
  function holds(input: Row, condition: string | undefined, item: Row | undefined): boolean {
    if (!condition) return true;
    return condition.split(" AND ").every((clause) => {
      const exists = clause.match(/^attribute_not_exists\((\w+)\)$/);
      if (exists) return !item || item[exists[1]!] === undefined;
      const eq = clause.match(/^(#?\w+) = (:\w+)$/);
      if (!eq) throw new Error(`unsupported condition: ${clause}`);
      const attr = names(input, eq[1]!);
      return item !== undefined && item[attr] === value(input, eq[2]!);
    });
  }

  /** Applies "SET a = :v, b = :w" to an item. */
  function apply(input: Row, expression: string, item: Row, table: string, key: Row) {
    const body = expression.replace(/^SET\s+/, "");
    for (const part of body.split(",")) {
      const [lhs, rhs] = part.split("=").map((s) => s.trim());
      item[names(input, lhs!)] = value(input, rhs!);
    }
    void table;
    void key;
  }

  function query(input: Row) {
    const table = tables.get(input.TableName)!;
    const [hash, range] = input.IndexName ? GSI[input.TableName]![input.IndexName]! : KEYS[input.TableName]!;
    const cond = input.KeyConditionExpression as string;
    const [attrText, token] = cond.split(" = ");
    const attr = names(input, attrText!.trim());
    const want = value(input, token!.trim());
    const rows = [...table.values()].filter((r) => r[attr] === want && (input.IndexName ? r[hash!] === want : true));
    const sortAttr = range;
    rows.sort((a, b) => String(a[sortAttr ?? ""] ?? "").localeCompare(String(b[sortAttr ?? ""] ?? "")));
    if (input.ScanIndexForward === false) rows.reverse();
    // A FilterExpression is applied before the limit, as DynamoDB does; this fake supports "attr = :value" only.
    const filter = input.FilterExpression as string | undefined;
    const kept = filter
      ? rows.filter((r) => {
          const m = filter.match(/^(\w+) = (:\w+)$/);
          if (!m) throw new Error(`unsupported filter: ${filter}`);
          return r[m[1]!] === value(input, m[2]!);
        })
      : rows;
    return { Items: kept.slice(0, input.Limit ?? kept.length).map((r) => structuredClone(r)) };
  }

  function single(command: string, input: Row) {
    const table = tables.get(input.TableName)!;
    if (command === "GetCommand") {
      const item = table.get(keyOf(input.TableName, input.Key));
      return { Item: item ? structuredClone(item) : undefined };
    }
    if (command === "QueryCommand") return query(input);
    if (command === "PutCommand") {
      const k = keyOf(input.TableName, input.Item);
      const current = table.get(k);
      if (!holds(input, input.ConditionExpression, current)) throw fail();
      table.set(k, structuredClone(input.Item));
      return {};
    }
    if (command === "UpdateCommand") {
      const k = keyOf(input.TableName, input.Key);
      const current = table.get(k);
      if (!holds(input, input.ConditionExpression, current)) throw fail();
      const next = structuredClone(current ?? input.Key);
      apply(input, input.UpdateExpression, next, input.TableName, input.Key);
      table.set(k, next);
      return {};
    }
    if (command === "DeleteCommand") {
      const k = keyOf(input.TableName, input.Key);
      if (!holds(input, input.ConditionExpression, table.get(k))) throw fail();
      table.delete(k);
      return {};
    }
    throw new Error(`unsupported command ${command}`);
  }

  /** All-or-nothing: every check first, then every write. */
  function transact(items: Row[]) {
    const reasons: { Code: string }[] = [];
    for (const item of items) {
      const table = tables.get(item.Put?.TableName ?? item.Update?.TableName ?? item.ConditionCheck?.TableName)!;
      const spec = item.Put ?? item.Update ?? item.ConditionCheck;
      const key = item.Put ? keyOf(spec.TableName, spec.Item) : keyOf(spec.TableName, spec.Key);
      const ok = holds(spec, spec.ConditionExpression, table.get(key));
      reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
    }
    if (reasons.some((r) => r.Code !== "None")) {
      throw Object.assign(new Error("transaction canceled"), { name: "TransactionCanceledException", CancellationReasons: reasons });
    }
    for (const item of items) {
      if (item.Put) {
        tables.get(item.Put.TableName)!.set(keyOf(item.Put.TableName, item.Put.Item), structuredClone(item.Put.Item));
      } else if (item.Update) {
        const table = tables.get(item.Update.TableName)!;
        const k = keyOf(item.Update.TableName, item.Update.Key);
        const next = structuredClone(table.get(k) ?? item.Update.Key);
        apply(item.Update, item.Update.UpdateExpression, next, item.Update.TableName, item.Update.Key);
        table.set(k, next);
      }
    }
    return {};
  }

  const client = {
    send: async (command: { constructor: { name: string }; input: Row }) => {
      const name = command.constructor.name;
      if (name === "TransactWriteCommand") {
        const hook = hooks.beforeTransact;
        hooks.beforeTransact = undefined;
        hook?.();
        return transact(command.input.TransactItems);
      }
      return single(name, command.input);
    },
  };
  return { client, tables, hooks };
}
