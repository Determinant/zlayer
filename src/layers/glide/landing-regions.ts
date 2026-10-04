import { glideArtifactUrl, isGlideRegion, isGlideDependencies, type Bounds, type GlideArtifact, type GlideRegionReference,
  type GlideSource } from '@zlayer/contracts';
import { InvalidDataError } from '../../core/data/errors';
import { landingBoundsOverlap } from './landing-data';
import { readGlideIndex, readGlideJson } from './landing-packages';

export function glideRegionReference(source: GlideSource, id: string, bounds: Bounds[]): GlideRegionReference | undefined {
  return source.regions.find(region => region.id === id && JSON.stringify(region.bounds) === JSON.stringify(bounds));
}
export async function readGlideRegion(source: GlideSource, reference: GlideRegionReference, signal: AbortSignal, cacheOnly = false) {
  const value = await readGlideJson(source.root, reference, signal, cacheOnly);
  if (!isGlideRegion(value) || value.id !== reference.id || value.coverage !== reference.coverage
    || value.sourceSha256 !== source.inputSha256 || JSON.stringify(value.bounds) !== JSON.stringify(reference.bounds)) {
    throw new InvalidDataError('Glide region disagrees with its manifest');
  }
  return value;
}
/** Enumerate immutable regional closure without downloading or inflating polygon archives. */
export async function regionGlideArtifacts(source: GlideSource, id: string, bounds: Bounds[], signal: AbortSignal, cacheOnly = false): Promise<GlideArtifact[]> {
  const reference = glideRegionReference(source, id, bounds), files = new Map<string, GlideArtifact>();
  const add = (artifact: GlideArtifact) => {
    const previous = files.get(artifact.file);
    if (previous && (previous.bytes !== artifact.bytes || previous.sha256 !== artifact.sha256)) throw new InvalidDataError('Conflicting glide identities');
    files.set(artifact.file, artifact);
  };
  if (reference) {
    const region = await readGlideRegion(source, reference, signal, cacheOnly);
    add(reference);
    for (const file of region.files) add(file);
    for (const page of region.filePages ?? []) {
      const value = await readGlideJson(source.root, page, signal, cacheOnly);
      if (!isGlideDependencies(value)) throw new InvalidDataError('Invalid glide dependency page');
      add(page); for (const file of value.files) add(file);
    }
    const required = (artifact: GlideArtifact) => {
      const saved = files.get(artifact.file);
      if (!saved || saved.bytes !== artifact.bytes || saved.sha256 !== artifact.sha256) throw new InvalidDataError('Incomplete glide dependency closure');
    };
    required(source.coverage); required(source.provenance);
    for (const page of region.indexes) {
      required(page);
      const index = await readGlideIndex(source.root, page, signal, cacheOnly);
      for (const archive of index.archives) required(archive);
    }
    if ([...files.values()].reduce((n, f) => n + f.bytes, 0) !== reference.downloadBytes) throw new InvalidDataError('Glide region size mismatch');
  } else {
    // Custom/different envelopes cannot borrow a publisher inventory by name alone.
    add(source.coverage); add(source.provenance);
    for (const page of source.indexes) if (bounds.some(b => landingBoundsOverlap(page.bounds, b))) {
      add(page);
      const index = await readGlideIndex(source.root, page, signal, cacheOnly);
      for (const archive of index.archives) if (bounds.some(b => landingBoundsOverlap(archive.bounds, b))) add(archive);
    }
  }
  return [...files.values()];
}
export async function regionGlideFiles(bounds: Bounds[], id: string, source: GlideSource, base: string, signal: AbortSignal, cacheOnly = false) {
  source = { ...source, root: new URL(source.root, base).href };
  return (await regionGlideArtifacts(source, id, bounds, signal, cacheOnly)).map(file =>
    ({ kind: 'glide' as const, url: glideArtifactUrl(source.root, file), byteLength: file.bytes, sha256: file.sha256 }));
}
