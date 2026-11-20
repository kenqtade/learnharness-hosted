import test from "node:test";
import assert from "node:assert/strict";
import {
  det, eigen, eigenLines, eigenvalues, eigenvectors, formatMatrix, gridLineImages, identity, inverse, lerpMatrix, morphFromIdentity,
  multiply, rref, signedArea, solve, transformPoint, transpose, unitSquareImage,
} from "../src/engine/matrix.ts";

const close = (a: number, b: number, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} != ${b}`);

test("determinant, inverse and transpose", () => {
  assert.equal(det([[1, 2], [3, 4]]), -2);
  assert.equal(det([[2, 0, 0], [0, 3, 0], [0, 0, 4]]), 24);
  const matrix = [[4, 7], [2, 6]];
  const inverted = inverse(matrix);
  assert.ok(inverted);
  close(det(matrix) * det(inverted!), 1, 1e-12);
  const product = multiply(matrix, inverted!);
  close(product[0]![0]!, 1); close(product[0]![1]!, 0);
  close(product[1]![0]!, 0); close(product[1]![1]!, 1);
  assert.deepEqual(transpose([[1, 2, 3], [4, 5, 6]]), [[1, 4], [2, 5], [3, 6]]);
  assert.equal(inverse([[1, 2], [2, 4]]), undefined);
  assert.equal(formatMatrix([[1, 0], [0, 1]]), "1  0\n0  1");
});

test("RREF is exact with fractions", () => {
  const result = rref([[1, 2, 3], [4, 5, 6]]);
  assert.equal(result.rank, 2);
  assert.deepEqual(result.pivots, [0, 1]);
  assert.deepEqual(result.exact, [["1", "0", "-1"], ["0", "1", "2"]]);
  assert.deepEqual(result.matrix, [[1, 0, -1], [0, 1, 2]]);
  const thirds = rref([[1, 1, 1], [0, 3, 1]]);
  assert.deepEqual(thirds.exact, [["1", "0", "2/3"], ["0", "1", "1/3"]]);
  const identityRref = rref(identity(3));
  assert.deepEqual(identityRref.pivots, [0, 1, 2]);
});

test("eigenvalues of a diagonal matrix and a rotation", () => {
  const diagonal = eigenvalues([[2, 0], [0, 3]]);
  assert.equal(diagonal.length, 2);
  assert.ok(diagonal.some(value => Math.abs(value.re - 2) < 1e-9 && Math.abs(value.im) < 1e-9));
  assert.ok(diagonal.some(value => Math.abs(value.re - 3) < 1e-9 && Math.abs(value.im) < 1e-9));
  const rotation = eigenvalues([[0, -1], [1, 0]]);
  assert.ok(rotation.some(value => Math.abs(value.re) < 1e-9 && Math.abs(value.im - 1) < 1e-9));
  assert.ok(rotation.some(value => Math.abs(value.re) < 1e-9 && Math.abs(value.im + 1) < 1e-9));
  const result = eigen([[2, 0], [0, 3]]);
  assert.equal(result.values.length, 2);
  const first = result.eigenvectors[0]!;
  assert.ok(Math.hypot(first[0]!.im, first[1]!.im) < 1e-9);
});

test("eigenvectors satisfy Av = λv", () => {
  const matrix = [[2, 1], [1, 2]];
  const result = eigen(matrix);
  result.values.forEach((value, index) => {
    const vector = result.eigenvectors[index]!;
    const x = vector[0]!;
    const y = vector[1]!;
    const leftX = { re: matrix[0]![0]! * x.re + matrix[0]![1]! * y.re, im: matrix[0]![0]! * x.im + matrix[0]![1]! * y.im };
    const leftY = { re: matrix[1]![0]! * x.re + matrix[1]![1]! * y.re, im: matrix[1]![0]! * x.im + matrix[1]![1]! * y.im };
    const rightX = { re: value.re * x.re - value.im * x.im, im: value.re * x.im + value.im * x.re };
    const rightY = { re: value.re * y.re - value.im * y.im, im: value.re * y.im + value.im * y.re };
    close(leftX.re, rightX.re, 1e-8); close(leftX.im, rightX.im, 1e-8);
    close(leftY.re, rightY.re, 1e-8); close(leftY.im, rightY.im, 1e-8);
  });
});

test("solve Ax = b", () => {
  assert.deepEqual(solve([[2, 0], [0, 3]], [4, 9]), [2, 3]);
  const inconsistent = solve([[1, 1], [1, 1]], [1, 2]);
  assert.equal(inconsistent, undefined);
  const underdetermined = solve([[1, 1]], [2]);
  assert.equal(underdetermined, undefined);
});

test("transformation geometry: unit square area equals det", () => {
  const matrix = [[2, 1], [0, 3]];
  const square = unitSquareImage(matrix);
  assert.equal(square.length, 4);
  close(signedArea(square), det(matrix));
  const point = transformPoint(matrix, { x: 1, y: 1 });
  assert.deepEqual(point, { x: 3, y: 3 });
  const lines = gridLineImages(matrix, { x: [-2, 2], y: [-2, 2] }, 4);
  assert.equal(lines.length, 10);
  assert.ok(lines.every(line => Number.isFinite(line.from.x) && Number.isFinite(line.to.y)));
});

test("eigenlines and the I -> A morph", () => {
  const lines = eigenLines([[2, 0], [0, 3]]);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.point.x === 0 && line.point.y === 0));
  assert.deepEqual(eigenLines([[0, -1], [1, 0]]), []);
  assert.deepEqual(morphFromIdentity([[2, 4], [6, 8]], 0), identity(2));
  assert.deepEqual(morphFromIdentity([[2, 4], [6, 8]], 1), [[2, 4], [6, 8]]);
  assert.deepEqual(lerpMatrix([[0, 0], [0, 0]], [[2, 2], [2, 2]], 0.5), [[1, 1], [1, 1]]);
});
