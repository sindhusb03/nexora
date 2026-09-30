import { relative } from "node:path";

const PACKAGE_FILTERS = [
  ["packages/kernel/", "@nexora/kernel"],
  ["packages/db/", "@nexora/db"],
  ["apps/api/", "@nexora/api"],
  ["apps/web/", "@nexora/web"],
];

function quote(file) {
  return `'${file.replaceAll("'", "'\\''")}'`;
}

function typecheckCommands(files) {
  const filters = new Set();
  for (const file of files) {
    const rel = relative(process.cwd(), file).replaceAll("\\", "/");
    for (const [prefix, name] of PACKAGE_FILTERS) {
      if (rel.startsWith(prefix)) filters.add(name);
    }
  }
  return [...filters].map((name) => `pnpm --filter ${name} typecheck`);
}

export default {
  "*.{js,mjs,cjs,ts,tsx}": (files) => [
    `prettier --write ${files.map(quote).join(" ")}`,
    `eslint --fix --max-warnings 0 --no-warn-ignored ${files.map(quote).join(" ")}`,
    ...typecheckCommands(files),
  ],
  "*.{json,md,yml,yaml,css}": (files) => [`prettier --write ${files.map(quote).join(" ")}`],
};
