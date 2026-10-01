// Dependency-free (uses the project's TypeScript compiler) runtime import audit.
// Literal import/export/dynamic-import edges count; tests are not entry points.
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = path.join(root, 'web/tsconfig.json');
const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, path.dirname(configFile));
const sourceRoot = path.join(root, 'web/src') + path.sep;
const normalize = name => path.normalize(path.resolve(name));
const files = parsed.fileNames.map(normalize).filter(name => name.startsWith(sourceRoot) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name) && !name.endsWith('.d.ts') && !name.includes(path.sep + 'test' + path.sep));
const edges = new Map(), dynamic = [];
for (const name of files) {
  const source = ts.createSourceFile(name, fs.readFileSync(name, 'utf8'), ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      specifier = node.arguments[0];
      if (!specifier || !ts.isStringLiteralLike(specifier)) dynamic.push(path.relative(root, name));
    }
    if (specifier && ts.isStringLiteralLike(specifier)) {
      const resolved = ts.resolveModuleName(specifier.text, name, parsed.options, ts.sys).resolvedModule;
      if (resolved) imports.push(normalize(resolved.resolvedFileName));
    }
    ts.forEachChild(node, visit);
  }
  visit(source); edges.set(name, imports);
}
const reachable = new Set();
function walk(name) { if (reachable.has(name)) return; reachable.add(name); for (const next of edges.get(name) ?? []) walk(next); }
walk(path.join(sourceRoot, 'main.tsx'));
const unused = files.filter(name => !reachable.has(name)).map(name => path.relative(root, name).replaceAll('\\', '/'));
console.log(JSON.stringify({ productionFiles: files.length, reachableFiles: files.length - unused.length, nonliteralImports: dynamic, unused }, null, 2));
if (process.argv.includes('--check') && (unused.length || dynamic.length)) process.exitCode = 1;
