import test from "node:test";
import assert from "node:assert/strict";
import {
  add, argument, complex, domainColor, domainColorAt, domainColoring, formatComplex, gridImages, modulus, multiply,
  nthRoots, productGeometry, rootsOfUnity, sumGeometry,
} from "../src/engine/complex.ts";

test("complex arithmetic and geometry", () => {
  const sum = add(complex(1, 2), complex(3, -1));
  assert.deepEqual(sum, { re: 4, im: 1 });
  const product = multiply(complex(1, 1), complex(0, 1));
  assert.ok(Math.abs(product.re + 1) < 1e-12);
  assert.ok(Math.abs(product.im - 1) < 1e-12);
  assert.equal(formatComplex(complex(2, -1)), "2 − i");
  assert.equal(formatComplex(complex(0, 1)), "i");
  assert.equal(sumGeometry(complex(1, 0), complex(0, 1)).vertices.length, 4);
  const geometry = productGeometry(complex(1, 0), complex(0, 2));
  assert.ok(Math.abs(geometry.scale - 2) < 1e-12);
  assert.ok(Math.abs(geometry.angle - Math.PI / 2) < 1e-12);
});

test("nth roots and roots of unity", () => {
  const roots = rootsOfUnity(4);
  assert.equal(roots.length, 4);
  for (const root of roots) assert.ok(Math.abs(modulus(root) - 1) < 1e-12);
  assert.ok(Math.abs(roots[0]!.re - 1) < 1e-12);
  assert.ok(Math.abs(roots[1]!.im - 1) < 1e-12);
  assert.ok(Math.abs(roots[2]!.re + 1) < 1e-12);
  const cube = nthRoots(complex(8), 3);
  assert.equal(cube.length, 3);
  for (const root of cube) {
    const powered = multiply(multiply(root, root), root);
    assert.ok(Math.abs(powered.re - 8) < 1e-9);
    assert.ok(Math.abs(powered.im) < 1e-9);
  }
});

test("domain colouring hue follows the argument", () => {
  const atOne = domainColorAt(z => z, complex(1, 0));
  const atI = domainColorAt(z => z, complex(0, 1));
  assert.ok(Math.abs(atOne.hue) < 1e-9);
  assert.ok(Math.abs(atI.hue - 90) < 1e-9);
  assert.ok(Math.abs(argument(complex(0, 1)) - Math.PI / 2) < 1e-12);
  assert.ok(atOne.lightness > 0 && atOne.lightness <= 1);
  const zero = domainColor(complex(0, 0));
  assert.equal(zero.lightness < 0.2, true);
});

test("domain colouring produces an RGBA buffer", () => {
  const image = domainColoring(z => z, 120, 80, { x: [-2, 2], y: [-2, 2] });
  assert.equal(image.width, 120);
  assert.equal(image.height, 80);
  assert.equal(image.data.length, 120 * 80 * 4);
  // Pixel at the right-centre is near z = 2 (red-ish, hue 0).
  const row = 40;
  const col = 119;
  const offset = (row * image.width + col) * 4;
  assert.ok(image.data[offset]! > image.data[offset + 1]!);
  assert.equal(image.data[offset + 3], 255);
});

test("grid images of a Möbius map stay finite and multiple", () => {
  const curves = gridImages(z => ({ re: z.re / (z.re * z.re + z.im * z.im), im: -z.im / (z.re * z.re + z.im * z.im) }), { x: [-2, 2], y: [-2, 2] }, 4, 20);
  assert.ok(curves.length > 4);
  for (const curve of curves) for (const point of curve) assert.ok(Number.isFinite(point.re) && Number.isFinite(point.im));
});
