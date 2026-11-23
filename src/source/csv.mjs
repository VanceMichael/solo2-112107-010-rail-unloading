// 极简 CSV 解析（RFC 4180 子集：逗号分隔、双引号包裹、引号内转义、CRLF/LF）。
// 磅房数据来自独立发布接口，规模小且列固定；不引入第三方依赖。

/**
 * 把 CSV 文本解析为对象数组，首行为表头。
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
export function parseCsv(text) {
  const rows = tokenize(text);
  if (rows.length === 0) return [];
  const header = rows[0];
  return rows.slice(1)
    // 跳过完全空行
    .filter((cells) => !(cells.length === 1 && cells[0] === ''))
    .map((cells) => {
      const record = {};
      header.forEach((name, i) => {
        record[name] = cells[i] ?? '';
      });
      return record;
    });
}

function tokenize(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let hasContent = false; // 本行是否出现过任何字段（区分真正的空行与末尾换行）

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      hasContent = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
      hasContent = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (hasContent) rows.push(row);
      row = [];
      field = '';
      hasContent = false;
    } else {
      field += ch;
      hasContent = true;
    }
  }
  if (hasContent || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
