import { JsonSchema, Schema } from "./base.js";

export class StringSchema extends Schema {
  constructor(
    private description = "",
    private opts: { minLength?: number; maxLength?: number; enum?: any[]; nullable?: boolean } = {},
  ) {
    super();
  }

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = { type: this.opts.nullable ? ["string", "null"] : "string" };
    if (this.description) out.description = this.description;
    if (this.opts.minLength != null) out.minLength = this.opts.minLength;
    if (this.opts.maxLength != null) out.maxLength = this.opts.maxLength;
    if (this.opts.enum) out.enum = [...this.opts.enum];
    return out;
  }
}

export class IntegerSchema extends Schema {
  constructor(
    value = 0,
    private opts: { description?: string; minimum?: number; maximum?: number; enum?: number[]; nullable?: boolean } = {},
  ) {
    super();
    void value;
  }

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = { type: this.opts.nullable ? ["integer", "null"] : "integer" };
    if (this.opts.description) out.description = this.opts.description;
    if (this.opts.minimum != null) out.minimum = this.opts.minimum;
    if (this.opts.maximum != null) out.maximum = this.opts.maximum;
    if (this.opts.enum) out.enum = [...this.opts.enum];
    return out;
  }
}

export class NumberSchema extends Schema {
  constructor(
    value = 0,
    private opts: { description?: string; minimum?: number; maximum?: number; enum?: number[]; nullable?: boolean } = {},
  ) {
    super();
    void value;
  }

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = { type: this.opts.nullable ? ["number", "null"] : "number" };
    if (this.opts.description) out.description = this.opts.description;
    if (this.opts.minimum != null) out.minimum = this.opts.minimum;
    if (this.opts.maximum != null) out.maximum = this.opts.maximum;
    if (this.opts.enum) out.enum = [...this.opts.enum];
    return out;
  }
}

export class BooleanSchema extends Schema {
  constructor(private opts: { description?: string; default?: boolean; nullable?: boolean } = {}) {
    super();
  }

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = { type: this.opts.nullable ? ["boolean", "null"] : "boolean" };
    if (this.opts.description) out.description = this.opts.description;
    if (this.opts.default != null) out.default = this.opts.default;
    return out;
  }
}

export class ArraySchema extends Schema {
  constructor(
    private items: any = new StringSchema(""),
    private opts: { description?: string; minItems?: number; maxItems?: number; nullable?: boolean } = {},
  ) {
    super();
  }

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = {
      type: this.opts.nullable ? ["array", "null"] : "array",
      items: Schema.fragment(this.items),
    };
    if (this.opts.description) out.description = this.opts.description;
    if (this.opts.minItems != null) out.minItems = this.opts.minItems;
    if (this.opts.maxItems != null) out.maxItems = this.opts.maxItems;
    return out;
  }
}

export class ObjectSchema extends Schema {
  properties: Record<string, any>;
  required: string[];
  constructor(
    properties: Record<string, any> = {},
    opts: {
      required?: string[];
      description?: string;
      additionalProperties?: boolean | JsonSchema;
      nullable?: boolean;
      [key: string]: any;
    } = {},
  ) {
    super();
    const { required, description, additionalProperties, nullable, ...rest } = opts;
    void description;
    void additionalProperties;
    void nullable;
    this.properties = { ...properties, ...rest };
    this.required = required ?? [];
    this.opts = opts;
  }

  private opts: any;

  toJsonSchema(): JsonSchema {
    const out: JsonSchema = {
      type: this.opts.nullable ? ["object", "null"] : "object",
      properties: Object.fromEntries(
        Object.entries(this.properties).map(([key, value]) => [key, Schema.fragment(value)]),
      ),
    };
    if (this.required.length) out.required = [...this.required];
    if (this.opts.description) out.description = this.opts.description;
    if (this.opts.additionalProperties != null) out.additionalProperties = this.opts.additionalProperties;
    return out;
  }
}

export function toolParametersSchema({
  required,
  description = "",
  ...properties
}: { required?: string[]; description?: string; [key: string]: any } = {}): JsonSchema {
  return new ObjectSchema(properties, { required, description }).toJsonSchema();
}
