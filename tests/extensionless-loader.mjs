const sourceExtensions = [".ts", ".tsx", ".js"];

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+(?:\?.*)?$/i.test(specifier)) {
    for (const extension of sourceExtensions) {
      try {
        return await nextResolve(`${specifier}${extension}`, context);
      } catch {
        // Try the next source extension.
      }
    }
  }
  return nextResolve(specifier, context);
}