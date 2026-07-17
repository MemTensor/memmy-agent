export type JsonSchema = Record<string, any>;

export type ToolExecutionContext = {
  abortSignal?: AbortSignal | null;
  toolName?: string;
  callId?: string | null;
};

const JSON_TYPE_MAP: Record<string, (value: any) => boolean> = {
  string: (value) => typeof value === "string",
  integer: (value) => Number.isInteger(value) && typeof value !== "boolean",
  number: (value) => typeof value === "number" && !Number.isNaN(value),
  boolean: (value) => typeof value === "boolean",
  array: (value) => Array.isArray(value),
  object: (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
};

export abstract class Schema {
  static resolveJsonSchemaType(t: any): string | null {
    if (Array.isArray(t)) return t.find((x) => x !== "null") ?? null;
    return t ?? null;
  }

  static subpath(path: string, key: string): string {
    return path ? `${path}.${key}` : key;
  }

  static validateJsonSchemaValue(value: any, schema: JsonSchema, path = ""): string[] {
    const rawType = schema.type;
    const nullable = (Array.isArray(rawType) && rawType.includes("null")) || schema.nullable === true;
    const type = Schema.resolveJsonSchemaType(rawType);
    const label = path || "parameter";

    if (nullable && value === null) return [];
    if (type && JSON_TYPE_MAP[type] && !JSON_TYPE_MAP[type](value)) {
      return [`${label} should be ${type}`];
    }

    const errors: string[] = [];
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${label} must be one of ${schema.enum}`);
    if (type === "integer" || type === "number") {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${label} must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${label} must be <= ${schema.maximum}`);
      }
    }
    if (type === "string") {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${label} must be at least ${schema.minLength} chars`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${label} must be at most ${schema.maxLength} chars`);
      }
    }
    if (type === "object") {
      const props = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`missing required ${Schema.subpath(path, key)}`);
      }
      for (const [key, child] of Object.entries(value)) {
        if (props[key]) errors.push(...Schema.validateJsonSchemaValue(child, props[key], Schema.subpath(path, key)));
      }
    }
    if (type === "array") {
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${label} must have at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${label} must be at most ${schema.maxItems} items`);
      }
      if (schema.items) {
        value.forEach((item: any, index: number) => {
          errors.push(...Schema.validateJsonSchemaValue(item, schema.items, path ? `${path}[${index}]` : `[${index}]`));
        });
      }
    }
    return errors;
  }

  static fragment(value: any): JsonSchema {
    if (value && typeof value.toJsonSchema === "function") return value.toJsonSchema();
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    throw new TypeError(`Expected schema object, got ${typeof value}`);
  }

  abstract toJsonSchema(): JsonSchema;

  validateValue(value: any, path = ""): string[] {
    return Schema.validateJsonSchemaValue(value, this.toJsonSchema(), path);
  }
}

export abstract class Tool {
  static configKey = "";
  static pluginDiscoverable = true;
  configKey = "";
  pluginDiscoverable = true;
  scopes = new Set(["core"]);

  abstract get name(): string;
  abstract get description(): string;
  abstract get parameters(): JsonSchema;

  get readOnly(): boolean {
    return false;
  }

  get exclusive(): boolean {
    return false;
  }

  get concurrencySafe(): boolean {
    return this.readOnly && !this.exclusive;
  }

  static configCls(): any {
    return null;
  }

  static enabled(ctx: any): boolean {
    return true;
  }

  static create(ctx?: any): Tool {
    return new (this as any)() as Tool;
  }

  abstract execute(params?: Record<string, any>, context?: ToolExecutionContext): Promise<any> | any;

  protected resolveType(t: any): string | null {
    return Schema.resolveJsonSchemaType(t);
  }

  private castObject(obj: any, schema: JsonSchema): any {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
    const props = schema.properties ?? {};
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [key, props[key] ? this.castValue(value, props[key]) : value]),
    );
  }

  castParams(params: Record<string, any>): Record<string, any> {
    const schema = this.parameters ?? {};
    if ((schema.type ?? "object") !== "object") return params;
    return this.castObject(params, schema);
  }

  private castValue(value: any, schema: JsonSchema): any {
    const type = this.resolveType(schema.type);
    if (type === "integer" && typeof value === "string") {
      const num = Number(value);
      return Number.isInteger(num) ? num : value;
    }
    if (type === "number" && typeof value === "string") {
      const num = Number(value);
      return Number.isFinite(num) ? num : value;
    }
    if (type === "string") return value == null ? value : String(value);
    if (type === "boolean" && typeof value === "string") {
      const low = value.toLowerCase();
      if (["true", "1", "yes"].includes(low)) return true;
      if (["false", "0", "no"].includes(low)) return false;
    }
    if (type === "array" && Array.isArray(value) && schema.items) {
      return value.map((item) => this.castValue(item, schema.items));
    }
    if (type === "object") return this.castObject(value, schema);
    return value;
  }

  validateParams(params: any): string[] {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      return [`parameters must be an object, got ${Array.isArray(params) ? "array" : typeof params}`];
    }
    const schema = this.parameters ?? {};
    if ((schema.type ?? "object") !== "object") {
      throw new Error(`Schema must be object type, got ${schema.type}`);
    }
    return Schema.validateJsonSchemaValue(params, { ...schema, type: "object" });
  }

  toSchema(): JsonSchema {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}

export function toolParameters<T extends abstract new (...args: any[]) => Tool>(schema: JsonSchema) {
  const frozen = structuredClone(schema);
  return (cls: T): T => {
    Object.defineProperty(cls.prototype, "parameters", {
      configurable: true,
      get() {
        return structuredClone(frozen);
      },
    });
    return cls;
  };
}
