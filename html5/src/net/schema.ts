/** Типы схемы протокола (данные — в schema-data.ts, его генерирует tools/gen_protocol_schema.py). */

export type PrimitiveOpType =
  | 'i8'
  | 'i16'
  | 'i32'
  | 'u32'
  | 'i64'
  | 'f32'
  | 'f64'
  | 'bool'
  | 'str'
  | 'ascii'
  | 'len'
  | 'vec3';

export interface PrimitiveOp {
  t: PrimitiveOpType;
  n?: string;
}

export interface StructOp {
  t: 'struct';
  n?: string;
  o: Op[];
}

export interface ArrayOp {
  t: 'arr';
  n?: string;
  o: Op[];
}

export interface OptionalOp {
  t: 'opt';
  n?: string;
  o: Op[];
}

export interface RawOp {
  t: 'raw';
  n?: string;
  size: number;
}

export type Op = PrimitiveOp | StructOp | ArrayOp | OptionalOp | RawOp;

export interface ModelDataEntry {
  file: string;
  class: string;
  /** Пространство, в котором живёт модель: entrance / lobby / garage / battle / battle_list */
  space: string;
  ops: Op[];
}

/** Команда сервер -> клиент (из `*_model_commands.py`). */
export interface CommandEntry {
  model: number;
  modelClass: string;
  space: string;
  /** имя из send_command(..., "ИМЯ") */
  name: string;
  method: string;
  /** аргументы после id команды */
  ops: Op[];
}

export interface SchemaFile {
  version: number;
  modelData: Record<string, ModelDataEntry>;
  modelDataDuplicates: Record<string, ModelDataEntry[]>;
  /** command_id -> варианты (один id бывает у нескольких моделей) */
  commands: Record<string, CommandEntry[]>;
  codecs: Record<string, { ops: Op[] }>;
  warnings: string[];
}
