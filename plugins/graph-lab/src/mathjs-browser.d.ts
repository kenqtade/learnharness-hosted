// mathjs ships `lib/browser/math.js` (UMD) without a declaration file. Graph Lab
// declares only the small surface it uses: loading mathjs's full declarations
// costs ~1 GB of type-checker memory, which breaks small CI machines.
declare module "mathjs/lib/browser/math.js" {
  export interface EvalFunction { evaluate(scope?: Record<string, unknown>): unknown }
  export interface MathNode {
    type: string;
    compile(): EvalFunction;
    evaluate(scope?: Record<string, unknown>): unknown;
    traverse(callback: (node: MathNode, path: string, parent: MathNode | null) => void): void;
    toString(): string;
  }
  export interface Fraction {
    s: bigint | number; n: bigint | number; d: bigint | number;
    abs(): Fraction; neg(): Fraction; clone(): Fraction; add(x: Fraction | number): Fraction; sub(x: Fraction | number): Fraction;
    mul(x: Fraction | number): Fraction; div(x: Fraction | number): Fraction; equals(x: Fraction | number): boolean;
    valueOf(): number; toFraction(excludeWhole?: boolean): string; toString(): string;
  }
  export interface ComplexNumber { re: number; im: number }
  export interface MathJsLite {
    Complex: new (re: number, im?: number) => ComplexNumber;
    evaluate(expression: string, scope?: Record<string, unknown>): unknown;
    parse(expression: string): MathNode;
    eigs(matrix: number[][]): { values: unknown[]; eigenvectors?: { value: unknown; vector: unknown }[] };
    fraction(value: number | string): Fraction;
  }
  const math: MathJsLite;
  export default math;
}
