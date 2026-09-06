// TR-STACK-001, NFR-MNT-004: generated Prisma runtime does not need CLI/TS peers.
// Keep the pinned CLI at the workspace root for generation and developer migrations.
export const hooks = {
  readPackage(pkg) {
    const removed = pkg.name === "@prisma/client" && pkg.version === "7.10.0"
      ? ["prisma", "typescript"]
      : pkg.name === "cosmiconfig" && pkg.version === "8.3.6" ? ["typescript"] : [];
    if (removed.length) {
      for (const name of removed) {
        if (pkg.peerDependencies?.[name] !== undefined) {
          if (pkg.peerDependenciesMeta?.[name]?.optional !== true)
            throw new Error("Prisma build-peer contract changed; dependency review required");
          delete pkg.peerDependencies[name];
          delete pkg.peerDependenciesMeta[name];
        }
      }
    }
    return pkg;
  },
};
