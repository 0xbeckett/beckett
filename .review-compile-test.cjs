const vm = require("vm");
function compileCode(code) {
  const expression = `(async () => (${code}\n))()`;
  try {
    return new vm.Script(expression, { filename: "expr.js" });
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return new vm.Script(`(async () => {\n${code}\n})()`, { filename: "stmt.js" });
  }
}
const s = compileCode("return page.url()");
console.log("compiled OK");
