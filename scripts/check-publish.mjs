import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const gitFiles = (...args) => execFileSync("git", ["ls-files", "-z", ...args], {
  encoding: "utf8",
}).split("\0").filter(Boolean);
const tracked = gitFiles("--cached");
const trackedSet = new Set(tracked);
const candidates = [...new Set([...tracked, ...gitFiles("--others", "--exclude-standard")])];
const sensitivePath = (path) => {
  const name = basename(path).toLowerCase();
  return path.split("/").includes(".vercel") ||
    (name.startsWith(".env") && name !== ".env.example") ||
    name.startsWith("env.local") || /\.(?:pem|key|p12|pfx)$/.test(name);
};
const trackedSecrets = tracked.filter(sensitivePath);
if (trackedSecrets.length) {
  console.error("STOP: Git śledzi pliki mogące zawierać sekrety:");
  for (const path of trackedSecrets) console.error(path);
  process.exit(1);
}

const problems = [];
for (const path of candidates) {
  if (sensitivePath(path)) {
    problems.push(`${path}: plik może zawierać sekrety`);
    continue; // Nigdy nie otwieramy plików z konfiguracją prywatną.
  }
  if (lstatSync(path).isSymbolicLink()) {
    problems.push(`${path}: dowiązanie wymaga ręcznego przeglądu`);
    continue;
  }
  // Sprawdzamy także indeks Git: commit może zawierać inną treść niż plik na dysku.
  const sources = [readFileSync(path, "utf8")];
  if (trackedSet.has(path)) sources.push(execFileSync("git", ["show", `:${path}`], { encoding: "utf8" }));
  if (basename(path) === ".env.example" && sources.some((source) => source.split(/\r?\n/).some((line) => {
    const text = line.trim();
    return text && !text.startsWith("#") && !/^[A-Z_][A-Z0-9_]*=\s*$/.test(text);
  }))) problems.push(`${path}: wzór zmiennych musi mieć puste wartości`);

  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{20,}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
  ];
  if (sources.some((source) => secretPatterns.some((pattern) => pattern.test(source)))) {
    problems.push(`${path}: wykryto wzorzec sekretu — publikacja zablokowana`);
  }
}

for (const path of [".env", ".env.local", ".env.production", ".env.local.txt", ".env.local.rtf", "env.local.rtf", ".vercel/project.json"]) {
  if (spawnSync("git", ["check-ignore", "--quiet", "--no-index", path]).status !== 0) {
    problems.push(`${path}: brak ochrony przez .gitignore`);
  }
}
if (spawnSync("git", ["check-ignore", "--quiet", ".env.example"]).status === 0) {
  problems.push(".env.example: pusty wzór powinien trafić do repozytorium");
}
if (problems.length) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
console.log(`Sprawdzono ${candidates.length} plików. Brak śledzonych plików sekretów i znanych wzorców kluczy. Prywatne pliki .env nie były odczytywane.`);
console.log("Pliki przygotowane do publikacji:");
for (const path of candidates.sort()) console.log(path);
