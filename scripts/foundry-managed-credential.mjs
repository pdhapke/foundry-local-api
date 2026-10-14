import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, rmdirSync, openSync, fsyncSync, closeSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const managedDirectory = fileURLToPath(new URL("../server/.managed-credential", import.meta.url));
const failure = () => new Error("Managed local credential unavailable; repair requires explicit operator action.");

function verifyPrivateState(directory, file) {
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw failure();
  if (process.platform !== "win32") {
    if ((lstatSync(directory).mode & 0o077) || (lstatSync(file).mode & 0o077)) throw failure();
    return;
  }
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; foreach($p in @(${literal(directory)},${literal(file)})){ $acl=Get-Acl -LiteralPath $p; $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow'){throw 'PRIVATE_ACL_REQUIRED'} }; if(-not (Get-Acl -LiteralPath ${literal(directory)}).AreAccessRulesProtected){throw 'PRIVATE_ACL_REQUIRED'}`;
  const environment = { ...process.env };
  delete environment.PSModulePath;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, env: environment });
}

function restrictDirectory(directory) {
  if (process.platform !== "win32") return;
  const pathLiteral = `'${directory.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $p=${pathLiteral}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; & icacls.exe $p '/inheritance:r' '/grant:r' ('*'+$sid.Value+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE){throw 'ACL_FAILED'}; $rules=@((Get-Acl -LiteralPath $p).GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); foreach($r in $rules){ if($r.IdentityReference.Value -ne $sid.Value){ & icacls.exe $p '/remove' ('*'+$r.IdentityReference.Value) | Out-Null; if($LASTEXITCODE){throw 'ACL_FAILED'} } }; $check=Get-Acl -LiteralPath $p; $rules=@($check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); if (-not $check.AreAccessRulesProtected -or $rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow') { throw 'PRIVATE_ACL_REQUIRED' }`;
  const aclEnvironment = { ...process.env };
  delete aclEnvironment.PSModulePath;
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "ignore", windowsHide: true, env: aclEnvironment });
}

export function readManagedCredential(directory = managedDirectory) {
  if (!existsSync(directory)) {
    if (existsSync(`${directory}.required`)) throw failure();
    return null;
  }
  try {
    const file = join(directory, "current.json");
    verifyPrivateState(directory, file);
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (record.version !== 1 || !Number.isSafeInteger(record.generation) || record.generation < 1 || !/^[a-f0-9]{64}$/.test(record.key)) throw failure();
    return record;
  } catch { throw failure(); }
}

/** Explicit stopped-runtime operator operation; never imports a legacy key. */
export function replaceManagedCredential({ directory = managedDirectory, initialize = false, recover = false, random = randomBytes } = {}) {
  const parent = join(directory, "..");
  const lock = join(parent, ".managed-credential.lock");
  try { mkdirSync(lock, { mode: 0o700 }); } catch { throw new Error("Credential operation refused: another operation or unresolved lock exists."); }
  let temporary;
  try {
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw failure();
    let prior;
    try { prior = readManagedCredential(directory); }
    catch { if (!recover) throw failure(); }
    if (recover && prior) throw failure();
    if (recover && !existsSync(`${directory}.required`) && !existsSync(directory)) throw failure();
    if (!prior && !initialize && !recover) throw failure();
    if (prior && initialize) throw new Error("Managed credential already initialized; use explicit rotation.");
    if (!existsSync(`${directory}.required`)) {
      writeFileSync(`${directory}.required`, "managed-v1\n", { flag: "wx", mode: 0o600 });
      const marker = openSync(`${directory}.required`, "r+");
      try { fsyncSync(marker); } finally { closeSync(marker); }
    }
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      // Windows ignores POSIX mode bits. Protect the directory before writing
      // any secret; failed ACL application leaves a fail-closed marker.
    }
    restrictDirectory(directory);
    const next = { version: 1, generation: (prior?.generation ?? 0) + 1, key: random(32).toString("hex") };
    if (!/^[a-f0-9]{64}$/.test(next.key)) throw failure();
    temporary = join(directory, `next-${randomBytes(12).toString("hex")}.json`);
    writeFileSync(temporary, JSON.stringify(next), { flag: "wx", mode: 0o600 });
    const descriptor = openSync(temporary, "r+");
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, join(directory, "current.json"));
    temporary = undefined;
    return { generation: next.generation };
  } catch { throw new Error("Credential operation failed; no legacy credential fallback is permitted once initialized."); }
  finally {
    if (temporary && existsSync(temporary)) unlinkSync(temporary);
    rmdirSync(lock);
  }
}
