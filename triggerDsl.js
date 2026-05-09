/* Trigger DSL parser + evaluator — BATCH13.pdf p.8
   Operators: < > <= >= == != AND OR NOT is_unknown(field) always
   Evaluation rules: comparisons against null/unknown → false.
   Strings in single quotes only. */

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (c === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) throw new Error(`Unterminated string at ${i}`);
      tokens.push({ type: 'STRING', value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (c === '<' || c === '>' || c === '=' || c === '!') {
      let op = c;
      if (input[i + 1] === '=') { op += '='; i += 2; }
      else { i++; }
      if (op === '=') throw new Error(`Use == for equality at ${i}`);
      tokens.push({ type: 'OP', value: op });
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let n = '';
      while (i < input.length && /[0-9.]/.test(input[i])) { n += input[i]; i++; }
      tokens.push({ type: 'NUMBER', value: parseFloat(n) });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let id = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) { id += input[i]; i++; }
      const upper = id.toUpperCase();
      if (upper === 'AND' || upper === 'OR' || upper === 'NOT') {
        tokens.push({ type: 'LOGICAL', value: upper });
      } else if (id === 'always') {
        tokens.push({ type: 'ALWAYS' });
      } else if (id === 'is_unknown') {
        tokens.push({ type: 'IS_UNKNOWN' });
      } else if (id === 'true' || id === 'false') {
        tokens.push({ type: 'BOOL', value: id === 'true' });
      } else {
        tokens.push({ type: 'IDENT', value: id });
      }
      continue;
    }
    throw new Error(`Unexpected character '${c}' at ${i}`);
  }
  return tokens;
}

function parse(input) {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type) => {
    const t = tokens[pos];
    if (!t || t.type !== type) {
      throw new Error(`Expected ${type}, got ${t ? t.type : 'EOF'}`);
    }
    pos++;
    return t;
  };

  function parseExpr() { return parseOr(); }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'LOGICAL' && peek().value === 'OR') {
      pos++;
      left = { type: 'OR', left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd() {
    let left = parseNot();
    while (peek() && peek().type === 'LOGICAL' && peek().value === 'AND') {
      pos++;
      left = { type: 'AND', left, right: parseNot() };
    }
    return left;
  }

  function parseNot() {
    if (peek() && peek().type === 'LOGICAL' && peek().value === 'NOT') {
      pos++;
      return { type: 'NOT', operand: parseNot() };
    }
    return parseAtom();
  }

  function parseAtom() {
    const t = peek();
    if (!t) throw new Error('Unexpected EOF');
    if (t.type === 'LPAREN') {
      pos++;
      const e = parseExpr();
      eat('RPAREN');
      return e;
    }
    if (t.type === 'ALWAYS') { pos++; return { type: 'ALWAYS' }; }
    if (t.type === 'IS_UNKNOWN') {
      pos++;
      eat('LPAREN');
      const id = eat('IDENT').value;
      eat('RPAREN');
      return { type: 'IS_UNKNOWN', field: id };
    }
    return parseComparison();
  }

  function parseComparison() {
    const left = parsePrimary();
    const op = peek();
    if (op && op.type === 'OP') {
      pos++;
      const right = parsePrimary();
      return { type: 'COMPARE', op: op.value, left, right };
    }
    return left;
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Unexpected EOF in primary');
    if (t.type === 'IDENT') { pos++; return { type: 'FIELD', name: t.value }; }
    if (t.type === 'NUMBER') { pos++; return { type: 'NUMBER', value: t.value }; }
    if (t.type === 'STRING') { pos++; return { type: 'STRING', value: t.value }; }
    if (t.type === 'BOOL') { pos++; return { type: 'BOOL', value: t.value }; }
    throw new Error(`Unexpected token ${t.type}`);
  }

  const ast = parseExpr();
  if (pos !== tokens.length) throw new Error(`Trailing tokens after parse at ${pos}`);
  return ast;
}

const isUnknownVal = (v) => v === null || v === undefined;

function evaluate(node, data) {
  switch (node.type) {
    case 'ALWAYS':
      return true;
    case 'IS_UNKNOWN':
      return isUnknownVal(data[node.field]);
    case 'NOT':
      return !evaluate(node.operand, data);
    case 'AND':
      return evaluate(node.left, data) && evaluate(node.right, data);
    case 'OR':
      return evaluate(node.left, data) || evaluate(node.right, data);
    case 'COMPARE': {
      const lv = resolveValue(node.left, data);
      const rv = resolveValue(node.right, data);
      if (isUnknownVal(lv) || isUnknownVal(rv)) return false;
      switch (node.op) {
        case '<':  return lv < rv;
        case '<=': return lv <= rv;
        case '>':  return lv > rv;
        case '>=': return lv >= rv;
        case '==': return lv === rv;
        case '!=': return lv !== rv;
        default: throw new Error(`Unknown op ${node.op}`);
      }
    }
    case 'FIELD':
    case 'NUMBER':
    case 'STRING':
    case 'BOOL':
      return resolveValue(node, data);
    default:
      throw new Error(`Unknown node type ${node.type}`);
  }
}

function resolveValue(node, data) {
  if (node.type === 'FIELD') return data[node.name];
  return node.value;
}

/* Magnitude factor per BATCH13 step 5.
   Rules derived from the worked examples in the PDF:
   - always → 0.5
   - is_unknown(field) (when true) → 0.5
   - field < N or field <= N (gap below threshold) → ratio gap; raw gap for ratings
   - field > N or field >= N → 0 (precondition gate, no gap)
   - field == const (boolean/string) → 1.0
   - field != const → 1.0
   AND / OR / NOT combine by max of triggered operand contributions. */
function magnitude(node, data) {
  switch (node.type) {
    case 'ALWAYS':
      return 0.5;
    case 'IS_UNKNOWN':
      return isUnknownVal(data[node.field]) ? 0.5 : 0;
    case 'NOT':
      return evaluate(node, data) ? 1.0 : 0;
    case 'AND':
    case 'OR': {
      const lm = evaluate(node.left, data) ? magnitude(node.left, data) : 0;
      const rm = evaluate(node.right, data) ? magnitude(node.right, data) : 0;
      return Math.max(lm, rm);
    }
    case 'COMPARE': {
      if (!evaluate(node, data)) return 0;
      const lv = resolveValue(node.left, data);
      const rv = resolveValue(node.right, data);
      const fieldName = node.left.type === 'FIELD' ? node.left.name : null;
      switch (node.op) {
        case '<':
        case '<=': {
          const gap = rv - lv;
          if (gap <= 0) return 0;
          if (fieldName && fieldName.includes('rating')) {
            return Math.min(gap, 1.0);
          }
          return Math.min(gap / rv, 1.0);
        }
        case '>':
        case '>=':
          return 0;
        case '==':
        case '!=':
          return 1.0;
        default:
          return 0;
      }
    }
    default:
      return 0;
  }
}

module.exports = { tokenize, parse, evaluate, magnitude };
