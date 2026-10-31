// Shared FogExploration lookups used by the fog exploration and Scene fog reset commands.
//
// Foundry v13+ clients only cache their *own* FogExploration documents in
// `game.collections.FogExploration` (see FogExploration.load in the Foundry client), so a GM client
// never sees a player's explored fog there. These helpers read the world database instead.

type FogDocument = FoundryDocument;

export function fogCollection(): Map<string, FogDocument> | undefined {
  return game.collections.get("FogExploration") as Map<string, FogDocument> | undefined;
}

/** True when the client can query the world database directly (Foundry's client backend). */
export function fogDatabaseAvailable(): boolean {
  return typeof CONFIG["FogExploration"]?.documentClass?.database?.get === "function";
}

function idOf(value: unknown): unknown {
  return value && typeof value === "object" && "id" in value
    ? (value as { id: unknown }).id
    : value;
}

/**
 * Read every persisted FogExploration for a Scene (optionally one user) straight from the world
 * database. Foundry v13+ clients only cache their *own* fog documents in
 * `game.collections.FogExploration`, so a GM never sees a player's fog there; the database query is
 * the authoritative path. Falls back to the local collection where no database backend exists.
 */
export async function queryFogDocuments(sceneId: string, userId?: string): Promise<FogDocument[]> {
  const documentClass = CONFIG["FogExploration"]?.documentClass;
  const database = documentClass?.database;
  let documents: FogDocument[];
  if (documentClass && database && typeof database.get === "function") {
    const query: Record<string, string> = { scene: sceneId };
    if (userId !== undefined) query["user"] = userId;
    documents = await database.get(documentClass, { query });
  } else {
    documents = Array.from(fogCollection()?.values() ?? []);
  }
  return documents.filter((document) => {
    const source = document.toObject();
    return (
      idOf(source["scene"]) === sceneId && (userId === undefined || idOf(source["user"]) === userId)
    );
  });
}
