// mathjs ships `lib/browser/math.js` without a sibling declaration file. Its
// runtime surface is the default mathjs instance, so reuse mathjs's own types.
declare module "mathjs/lib/browser/math.js" {
  export * from "mathjs";
}
