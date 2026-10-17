/**
 * 轻量 JSON Schema 校验器（零依赖）。
 *
 * 只覆盖本服务器 inputSchema 用到的关键字：type / properties / required /
 * additionalProperties / enum / items / minimum / maximum / minLength /
 * maxLength / pattern / minItems / maxItems / anyOf / default。
 *
 * 设计目标不是完整实现 JSON Schema，而是：对非法输入给出**可读的中文**问题
 * 列表，绝不抛出未捕获异常。校验失败的错误路径用 `参数名.子字段` 形式表达，
 * 方便调用方定位。
 */

const TYPE_LABEL = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数字",
  integer: "整数",
  boolean: "布尔值",
};

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

function matchType(value, type) {
  switch (type) {
    case "object":
      return typeOf(value) === "object";
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

function join(path, key) {
  return path ? `${path}.${key}` : String(key);
}

/**
 * 校验 value 是否符合 schema。
 * @returns {string[]} 中文问题列表；为空表示通过。
 */
export function validate(schema, value, path = "") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (Array.isArray(schema.anyOf)) {
    const allFail = schema.anyOf.every((sub) => validate(sub, value, path).length > 0);
    if (allFail) {
      errors.push(`${path || "参数"} 不符合任何允许的形式`);
    }
    return errors;
  }

  const type = schema.type;
  if (type && !matchType(value, type)) {
    errors.push(`${path || "参数"} 应为${TYPE_LABEL[type] ?? type}，实际是 ${typeOf(value)}`);
    return errors;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path || "参数"} 取值必须是 ${schema.enum.map((e) => `「${e}」`).join(" / ")} 之一`);
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push(`${path || "参数"} 长度不能少于 ${schema.minLength}`);
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push(`${path || "参数"} 长度不能超过 ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path || "参数"} 格式不合法（需匹配 ${schema.pattern}）`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push(`${path || "参数"} 不能小于 ${schema.minimum}`);
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push(`${path || "参数"} 不能大于 ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push(`${path || "参数"} 至少需要 ${schema.minItems} 项`);
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push(`${path || "参数"} 最多 ${schema.maxItems} 项`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(schema.items, item, `${path}[${i}]`));
      });
    }
    return errors;
  }

  if (value && typeof value === "object") {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined || value[key] === null) {
          errors.push(`缺少必填参数：${join(path, key)}`);
        }
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value[key] !== undefined) {
        errors.push(...validate(sub, value[key], join(path, key)));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push(`不认识的参数：${join(path, key)}`);
        }
      }
    }
  }

  return errors;
}

/**
 * 按 schema 里的 default 填充缺失字段（只处理顶层 object 的直接属性）。
 * 返回新对象，不修改入参。
 */
export function applyDefaults(schema, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const props = schema?.properties ?? {};
  const out = { ...value };
  for (const [key, sub] of Object.entries(props)) {
    if (out[key] === undefined && sub && sub.default !== undefined) {
      out[key] = sub.default;
    }
  }
  return out;
}

export default { validate, applyDefaults };
