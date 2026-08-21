import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  accessionShard,
  alignPackOffset,
  logicalObjectPrefix,
  PACK_MAX_BYTES,
  PACK_TARGET_BYTES,
} from './lib/storage-layout.mjs';

const CONTENT_TYPES = {
  'reference.fa.gz': 'application/gzip',
  'reference.fa.gz.fai': 'text/plain; charset=utf-8',
  'reference.fa.gz.gzi': 'application/octet-stream',
  'predicted-promoters.gff3.gz': 'application/gzip',
  'predicted-promoters.gff3.gz.tbi': 'application/octet-stream',
  'ncbi-annotations.gff3.gz': 'application/gzip',
  'ncbi-annotations.gff3.gz.tbi': 'application/octet-stream',
  'metadata.json': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const options = { source: '2026-08-07', release: '2026-08-11', sourceRelease: '2026-08-07', force: false, planOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--source') options.source = argv[++index];
    else if (value === '--release') options.release = argv[++index];
    else if (value === '--source-release') options.sourceRelease = argv[++index];
    else if (value === '--force') options.force = true;
    else if (value === '--plan-only') options.planOnly = true;
    else throw new Error('Unknown argument: ' + value);
  }
  for (const value of [options.source, options.release, options.sourceRelease]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Release identifiers must use YYYY-MM-DD.');
  }
  return options;
}

function gzipBuffer(value) {
  return new Promise((resolve, reject) => gzip(value, { level: 9 }, (error, result) => error ? reject(error) : resolve(result)));
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function sqlString(value) {
  return value === null || value === undefined ? 'NULL' : "'" + String(value).replaceAll("'", "''") + "'";
}

function sqlNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'NULL';
}

function normalizedSearchTokens(genome) {
  const values = [genome.accession, genome.organismName, genome.strain, genome.domain, genome.phylum, genome.className, genome.orderName || genome.order, genome.family, genome.genus];
  const tokens = new Set();
  for (const value of values) {
    for (const token of String(value || '').toLocaleLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}_.-]+/u)) {
      if (token) tokens.add(token.slice(0, 200));
    }
  }
  return [...tokens].sort();
}

export function planShardPacks(entries, options = {}) {
  const releaseId = options.releaseId || 'unversioned';
  const targetBytes = options.targetBytes || PACK_TARGET_BYTES;
  const maxBytes = options.maxBytes || PACK_MAX_BYTES;
  const sorted = [...entries].sort((left, right) => left.accession.localeCompare(right.accession) || left.file.localeCompare(right.file));
  /** @type {Array<{part: number, path: string, bytes: number, entries: Array<Record<string, any> & {offset: number}>}>} */
  const packs = [];
  let current = null;
  for (const entry of sorted) {
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > maxBytes) throw new Error(entry.file + ': invalid or oversized packed asset');
    let offset = current ? alignPackOffset(current.bytes) : 0;
    if (!current || (current.entries.length && offset + entry.bytes > targetBytes) || offset + entry.bytes > maxBytes) {
      const part = packs.length;
      current = {
        part,
        path: 'releases/' + releaseId + '/packs/pack-' + entry.shard + '-' + String(part).padStart(3, '0') + '.bin',
        bytes: 0,
        entries: [],
      };
      packs.push(current);
      offset = 0;
    }
    current.entries.push({ ...entry, offset });
    current.bytes = offset + entry.bytes;
  }
  return packs;
}

async function appendToPack(handle, source, offset, expectedBytes, expectedSha256) {
  const details = await stat(source);
  if (details.size !== expectedBytes) throw new Error(source + ': manifest byte count mismatch');
  const hash = createHash('sha256');
  let position = offset;
  for await (const chunk of createReadStream(source)) {
    hash.update(chunk);
    await handle.write(chunk, 0, chunk.length, position);
    position += chunk.length;
  }
  if (hash.digest('hex') !== expectedSha256) throw new Error(source + ': manifest SHA-256 mismatch');
}

function updateHashWithZeroes(hash, bytes) {
  const zeroes = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, bytes)));
  for (let remaining = bytes; remaining > 0;) {
    const length = Math.min(remaining, zeroes.length);
    hash.update(zeroes.subarray(0, length));
    remaining -= length;
  }
}

export async function hashPlannedPack(pack) {
  const packHash = createHash('sha256');
  let position = 0;
  for (const entry of pack.entries) {
    if (entry.offset < position) throw new Error(pack.path + ': overlapping Pack entries');
    updateHashWithZeroes(packHash, entry.offset - position);
    const details = await stat(entry.sourcePath);
    if (details.size !== entry.bytes) throw new Error(entry.sourcePath + ': manifest byte count mismatch');
    const entryHash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(entry.sourcePath)) {
      entryHash.update(chunk);
      packHash.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== entry.bytes || entryHash.digest('hex') !== entry.sha256) throw new Error(entry.sourcePath + ': manifest SHA-256 mismatch');
    position = entry.offset + entry.bytes;
  }
  if (position !== pack.bytes) throw new Error(pack.path + ': planned byte length mismatch');
  return packHash.digest('hex');
}

async function createLogicalFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await link(source, destination);
  } catch (error) {
    if (!['EPERM', 'EXDEV', 'EACCES', 'ENOTSUP'].includes(error && typeof error === 'object' ? error.code : '')) throw error;
    await copyFile(source, destination);
  }
}

function remapGenomeAssets(genome) {
  return Object.fromEntries(Object.entries(genome.assets).map(([key, value]) => [
    key,
    value ? genome.accession + '/' + path.basename(value) : null,
  ]));
}

function packedStorageForFiles(storage, files) {
  return {
    layout: 'packed-v1',
    logicalObjectPrefix: storage.logicalObjectPrefix,
    assets: Object.fromEntries(files
      .filter((file) => storage.assets[file])
      .map((file) => [file, storage.assets[file]])),
  };
}

function logicalAssetPath(genome, file) {
  return genome.storage.assets[file] ? genome.accession + '/' + file : null;
}

function genomeStatements(releaseId, genome) {
  const referenceStorage = {
    ...packedStorageForFiles(genome.storage, ['reference.fa.gz', 'reference.fa.gz.fai', 'reference.fa.gz.gzi', 'metadata.json']),
    files: {
      fasta: logicalAssetPath(genome, 'reference.fa.gz'),
      fai: logicalAssetPath(genome, 'reference.fa.gz.fai'),
      gzi: logicalAssetPath(genome, 'reference.fa.gz.gzi'),
      metadata: logicalAssetPath(genome, 'metadata.json'),
    },
  };
  const values = [
    sqlString(releaseId), sqlString(genome.accession), sqlString(genome.organismName), sqlString(genome.strain),
    sqlString(genome.domain), sqlString(genome.phylum), sqlString(genome.className), sqlString(genome.orderName || genome.order),
    sqlString(genome.family), sqlString(genome.genus), sqlString(genome.genomeSource), sqlString(genome.assemblyLevel),
    sqlNumber(genome.genomeSizeBp), sqlNumber(genome.gcContent), sqlNumber(genome.contigCount), sqlNumber(genome.completeness),
    sqlNumber(genome.contamination), sqlString(genome.defaultLocus), sqlString(genome.primarySequence),
    sqlString(JSON.stringify(referenceStorage)),
  ];
  const statements = [
    'INSERT INTO genomes (release_id, accession, organism_name, strain, domain, phylum, class_name, order_name, family, genus, genome_source, assembly_level, genome_size_bp, gc_content, contig_count, completeness, contamination, default_locus, primary_sequence, reference_storage_json) VALUES (' + values.join(', ') + ');',
  ];
  const promoterPath = logicalAssetPath(genome, 'predicted-promoters.gff3.gz');
  const promoterReady = Boolean(promoterPath);
  statements.push('INSERT INTO feature_sets (release_id, accession, feature_type, evidence_type, count_unit, feature_count, status, is_default, source_id, source_version, provenance_json, data_path, index_path, storage_json) VALUES (' + [
    sqlString(releaseId), sqlString(genome.accession), "'promoter'", "'prediction'", "'peak'",
    promoterReady ? sqlNumber(genome.predictedPromoterCount) : 'NULL', sqlString(promoterReady ? 'ready' : 'missing'), '1', "'rapptor'", "'unrecorded'", "'{}'",
    sqlString(promoterPath), sqlString(logicalAssetPath(genome, 'predicted-promoters.gff3.gz.tbi')),
    sqlString(JSON.stringify(packedStorageForFiles(genome.storage, ['predicted-promoters.gff3.gz', 'predicted-promoters.gff3.gz.tbi']))),
  ].join(', ') + ');');
  const annotationPath = logicalAssetPath(genome, 'ncbi-annotations.gff3.gz');
  const annotationStatus = genome.annotationStatus === 'available' && annotationPath
    ? 'ready'
    : genome.annotationStatus === 'incompatible' ? 'failed' : 'missing';
  statements.push('INSERT INTO feature_sets (release_id, accession, feature_type, evidence_type, count_unit, feature_count, status, is_default, source_id, source_version, provenance_json, data_path, index_path, storage_json) VALUES (' + [
    sqlString(releaseId), sqlString(genome.accession), "'gene_annotation'", "'annotation'", "'feature'",
    annotationStatus === 'ready' ? sqlNumber(genome.annotationFeatureCount) : 'NULL', sqlString(annotationStatus), '1', "'ncbi'", "'unrecorded'", "'{}'",
    annotationStatus === 'ready' ? sqlString(annotationPath) : 'NULL',
    annotationStatus === 'ready' ? sqlString(logicalAssetPath(genome, 'ncbi-annotations.gff3.gz.tbi')) : 'NULL',
    sqlString(JSON.stringify(packedStorageForFiles(genome.storage, ['ncbi-annotations.gff3.gz', 'ncbi-annotations.gff3.gz.tbi']))),
  ].join(', ') + ');');
  return statements;
}

function summaryValue(summary, keys, fallback = 0) {
  for (const key of keys) if (Number.isFinite(summary[key])) return summary[key];
  return fallback;
}

export async function buildPackedRelease({ projectRoot, source, release, sourceRelease, force = false, planOnly = false }) {
  const sourceRoot = path.join(projectRoot, '.data', 'releases', source);
  const outputRoot = path.join(projectRoot, '.data', 'releases', release);
  await stat(sourceRoot).catch(() => { throw new Error('Source release is missing: ' + sourceRoot); });
  const outputExists = await stat(outputRoot).then(() => true).catch(() => false);
  if (outputExists && !force) throw new Error('Release already exists: ' + outputRoot + ' (use --force)');
  await rm(outputRoot, { recursive: true, force: true });
  await Promise.all(['objects', 'packs', 'manifests', 'catalog', 'd1'].map((directory) => mkdir(path.join(outputRoot, directory), { recursive: true })));

  const sourceCatalog = JSON.parse(await readFile(path.join(sourceRoot, 'catalog.json'), 'utf8'));
  const sourceReleaseJson = JSON.parse(await readFile(path.join(sourceRoot, 'release.json'), 'utf8'));
  const genomeByAccession = new Map(sourceCatalog.genomes.map((genome) => [genome.accession, genome]));
  const sourceRows = (await readFile(path.join(sourceRoot, 'manifest.tsv'), 'utf8')).trimEnd().split(/\r?\n/).slice(1);
  const entriesByShard = new Map();
  for (const line of sourceRows) {
    const [relative, bytesValue, sha256] = line.split('\t');
    if (!relative.startsWith('objects/')) continue;
    const [, accession, ...fileParts] = relative.split('/');
    const file = fileParts.join('/');
    if (!genomeByAccession.has(accession) || !CONTENT_TYPES[file]) throw new Error('Unsupported release object: ' + relative);
    const shard = accessionShard(accession);
    const entry = { accession, file, shard, bytes: Number(bytesValue), sha256, sourcePath: path.join(sourceRoot, relative) };
    await createLogicalFile(entry.sourcePath, path.join(outputRoot, 'objects', logicalObjectPrefix(accession), file));
    if (!entriesByShard.has(shard)) entriesByShard.set(shard, []);
    entriesByShard.get(shard).push(entry);
  }

  const storageByAccession = new Map();
  const plannedPacks = [];
  for (const shard of [...entriesByShard.keys()].sort()) {
    const packs = planShardPacks(entriesByShard.get(shard), { releaseId: release });
    for (const pack of packs) {
      for (const entry of pack.entries) {
        const storage = storageByAccession.get(entry.accession) || {
          layout: 'packed-v1',
          logicalObjectPrefix: logicalObjectPrefix(entry.accession),
          assets: {},
        };
        storage.assets[entry.file] = {
          packPath: pack.path,
          offset: entry.offset,
          length: entry.bytes,
          sha256: entry.sha256,
          contentType: CONTENT_TYPES[entry.file],
        };
        storageByAccession.set(entry.accession, storage);
      }
      plannedPacks.push(pack);
    }
  }

  const physicalPacks = [];
  for (const pack of plannedPacks) {
    let sha256;
    if (planOnly) {
      sha256 = await hashPlannedPack(pack);
      console.error('Planned ' + pack.path + ': ' + pack.entries.length + ' logical files, ' + pack.bytes + ' bytes');
    } else {
      const relativePackPath = pack.path.replace('releases/' + release + '/', '');
      const localPackPath = path.join(outputRoot, relativePackPath);
      const handle = await open(localPackPath, 'w');
      try {
        for (const entry of pack.entries) {
          await appendToPack(handle, entry.sourcePath, entry.offset, entry.bytes, entry.sha256);
        }
        await handle.truncate(pack.bytes);
      } finally {
        await handle.close();
      }
      sha256 = await hashFile(localPackPath);
      console.error('Built ' + pack.path + ': ' + pack.entries.length + ' logical files, ' + pack.bytes + ' bytes');
    }
    physicalPacks.push({ path: pack.path, bytes: pack.bytes, sha256, shard: pack.entries[0].shard, part: pack.part });
  }

  const serializedPackPlan = {
    schemaVersion: 1,
    releaseId: release,
    sourceReleaseId: sourceRelease,
    alignment: 4096,
    targetBytes: PACK_TARGET_BYTES,
    maxBytes: PACK_MAX_BYTES,
    materialization: planOnly ? 'plan-only' : 'materialized',
    packs: plannedPacks.map((pack) => {
      const physical = physicalPacks.find((item) => item.path === pack.path);
      return {
        path: pack.path,
        shard: pack.entries[0].shard,
        part: pack.part,
        bytes: pack.bytes,
        sha256: physical.sha256,
        entries: pack.entries.map((entry) => ({
          accession: entry.accession,
          file: entry.file,
          shard: entry.shard,
          sourcePath: path.relative(projectRoot, entry.sourcePath).split(path.sep).join('/'),
          offset: entry.offset,
          bytes: entry.bytes,
          sha256: entry.sha256,
          contentType: CONTENT_TYPES[entry.file],
        })),
      };
    }),
  };
  await writeFile(path.join(outputRoot, 'pack-plan.json'), JSON.stringify(serializedPackPlan, null, 2) + '\n');

  const genomes = sourceCatalog.genomes.map((genome) => {
    const storage = storageByAccession.get(genome.accession);
    if (!storage) throw new Error(genome.accession + ': no packed storage mapping');
    return { ...genome, assets: remapGenomeAssets(genome), storage };
  });
  const generatedAt = release + 'T00:00:00.000Z';
  const releaseJson = {
    ...sourceReleaseJson,
    schemaVersion: 2,
    id: release,
    version: release,
    datasetVersion: release,
    date: release,
    generatedAt,
    sourceReleaseId: sourceRelease,
    layout: 'packed-v1',
    shardAlgorithm: 'sha256-prefix-2',
    hfRepository: 'liurulong/bacterial-promoter-genomes',
    hfRevision: 'main',
  };
  const catalog = { ...sourceCatalog, schemaVersion: 2, generatedAt, sourceReleaseId: sourceRelease, assetBase: '/api/remote-data', release: releaseJson, genomes };
  await writeFile(path.join(outputRoot, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  await writeFile(path.join(outputRoot, 'release.json'), JSON.stringify(releaseJson, null, 2) + '\n');

  const logicalRows = ['path\tbytes\tsha256'];
  const checksumRows = [];
  const shardDescriptions = [];
  const allShards = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));
  for (const shard of allShards) {
    const entries = (entriesByShard.get(shard) || []).sort((left, right) => left.accession.localeCompare(right.accession) || left.file.localeCompare(right.file));
    const shardRows = ['path\tbytes\tsha256'];
    const shardChecksums = [];
    for (const entry of entries) {
      const logicalPath = 'objects/' + logicalObjectPrefix(entry.accession) + '/' + entry.file;
      const row = logicalPath + '\t' + entry.bytes + '\t' + entry.sha256;
      shardRows.push(row);
      shardChecksums.push(entry.sha256 + '  ' + logicalPath);
      logicalRows.push(row);
      checksumRows.push(entry.sha256 + '  ' + logicalPath);
    }
    const shardGenomes = genomes.filter((genome) => accessionShard(genome.accession) === shard);
    const manifestPath = 'manifests/manifest-' + shard + '.tsv.gz';
    const checksumsPath = 'manifests/checksums-' + shard + '.sha256.gz';
    const catalogPath = 'catalog/genomes-' + shard + '.ndjson.gz';
    await writeFile(path.join(outputRoot, manifestPath), await gzipBuffer(shardRows.join('\n') + '\n'));
    await writeFile(path.join(outputRoot, checksumsPath), await gzipBuffer(shardChecksums.join('\n') + (shardChecksums.length ? '\n' : '')));
    await writeFile(path.join(outputRoot, catalogPath), await gzipBuffer(shardGenomes.map((genome) => JSON.stringify(genome)).join('\n') + (shardGenomes.length ? '\n' : '')));
    shardDescriptions.push({
      id: shard,
      genomeCount: shardGenomes.length,
      logicalFileCount: entries.length,
      logicalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
      manifestPath,
      checksumsPath,
      catalogPath,
      packs: physicalPacks.filter((pack) => pack.shard === shard).map((pack) => ({ path: pack.path, bytes: pack.bytes, sha256: pack.sha256 })),
    });
  }
  await writeFile(path.join(outputRoot, 'manifest.tsv'), logicalRows.join('\n') + '\n');
  await writeFile(path.join(outputRoot, 'checksums.sha256'), checksumRows.sort().join('\n') + '\n');
  await writeFile(path.join(outputRoot, 'packs-manifest.tsv'), ['path\tbytes\tsha256', ...physicalPacks.map((pack) => pack.path + '\t' + pack.bytes + '\t' + pack.sha256)].join('\n') + '\n');
  const manifestIndex = {
    schemaVersion: 2,
    releaseId: release,
    sourceReleaseId: sourceRelease,
    shardAlgorithm: 'sha256-prefix-2',
    logicalManifest: 'manifest.tsv',
    logicalChecksums: 'checksums.sha256',
    physicalPackManifest: 'packs-manifest.tsv',
    shards: shardDescriptions,
  };
  await writeFile(path.join(outputRoot, 'manifest-index.json'), JSON.stringify(manifestIndex, null, 2) + '\n');

  const summary = sourceCatalog.summary || {};
  const phylumCounts = new Map();
  for (const genome of genomes) if (genome.phylum) phylumCounts.set(genome.phylum, (phylumCounts.get(genome.phylum) || 0) + 1);
  const topPhyla = [...phylumCounts.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)).slice(0, 8);
  const featureSummary = {
    totalCircularOriginSplitFeatures: summaryValue(summary, ['circularOriginSplitFeatures']),
    totalCircularOriginSplitGenomes: summaryValue(summary, ['circularOriginSplitGenomes']),
    totalExperimentalTss: summaryValue(summary, ['totalExperimentalTss']),
    totalExperimentalGenomes: genomes.filter((genome) => (genome.experimentalDatasetCount || 0) > 0 || genome.experimentalTssCount > 0 || (genome.experimentalPromoterCount || 0) > 0).length,
    totalEvidencePublications: summaryValue(summary, ['totalEvidencePublications']),
    topPhyla,
  };
  const releaseValues = [
    sqlString(release), sqlString(sourceRelease), sqlString(release), sqlString(generatedAt), sqlString(releaseJson.description || null),
    "'packed-v1'", "'liurulong/bacterial-promoter-genomes'", "'main'",
    sqlString('https://huggingface.co/datasets/liurulong/bacterial-promoter-genomes/resolve/main/releases/' + release),
    "'manifest-index.json'", String(genomes.length), sqlString(JSON.stringify(featureSummary)),
  ];
  const releaseSql = 'BEGIN TRANSACTION;\nINSERT INTO releases (release_id, source_release_id, release_date, generated_at, description, storage_layout, hf_repository, hf_revision, release_asset_base_url, manifest_index_path, total_genomes, feature_summary_json) VALUES (' + releaseValues.join(', ') + ');\nCOMMIT;\n';
  await writeFile(path.join(outputRoot, 'd1', '000-release.sql'), releaseSql);
  for (let start = 0, part = 1; start < genomes.length; start += 500, part += 1) {
    const lines = ['BEGIN TRANSACTION;'];
    for (const genome of genomes.slice(start, start + 500)) {
      lines.push(...genomeStatements(release, genome));
      for (const token of normalizedSearchTokens(genome)) {
        lines.push('INSERT OR IGNORE INTO genome_search_terms (release_id, accession, token) VALUES (' + sqlString(release) + ', ' + sqlString(genome.accession) + ', ' + sqlString(token) + ');');
      }
    }
    lines.push('COMMIT;', '');
    await writeFile(path.join(outputRoot, 'd1', String(part).padStart(3, '0') + '-genomes.sql'), lines.join('\n'));
  }
  const facetLines = ['BEGIN TRANSACTION;'];
  const ranks = [['source', 'genomeSource'], ['domain', 'domain'], ['phylum', 'phylum'], ['class', 'className'], ['order', 'orderName'], ['family', 'family'], ['genus', 'genus']];
  const facetRows = new Set();
  for (const genome of genomes) {
    for (const [kind, field] of ranks) {
      const value = genome[field] || (field === 'orderName' ? genome.order : null);
      if (!value) continue;
      const hierarchyValues = [genome.domain, genome.phylum, genome.className, genome.orderName || genome.order, genome.family];
      const parentCount = kind === 'source' ? 0 : ranks.findIndex(([rankKind]) => rankKind === kind) - 1;
      const hierarchy = hierarchyValues.map((item, index) => sqlString(index < parentCount ? item || '' : ''));
      facetRows.add('INSERT OR IGNORE INTO facet_options (release_id, kind, value, domain, phylum, class_name, order_name, family) VALUES (' + [sqlString(release), sqlString(kind), sqlString(value), ...hierarchy].join(', ') + ');');
    }
  }
  facetLines.push(...[...facetRows].sort());
  facetLines.push('COMMIT;', '');
  await writeFile(path.join(outputRoot, 'd1', '999-facets.sql'), facetLines.join('\n'));
  await writeFile(path.join(outputRoot, 'd1', 'activate.sql'), [
    'BEGIN TRANSACTION;',
    'INSERT INTO portal_state (singleton, active_release_id) VALUES (1, ' + sqlString(release) + ') ON CONFLICT(singleton) DO UPDATE SET active_release_id = excluded.active_release_id;',
    'COMMIT;',
    '',
  ].join('\n'));
  const completionMarker = planOnly ? '.release-plan-complete.json' : '.release-complete.json';
  await writeFile(path.join(outputRoot, completionMarker), JSON.stringify({
    schemaVersion: 2,
    state: planOnly ? 'planned' : 'complete',
    datasetVersion: release,
    sourceReleaseId: sourceRelease,
    generatedAt,
    layout: 'packed-v1',
    manifestIndexSha256: await hashFile(path.join(outputRoot, 'manifest-index.json')),
    packsManifestSha256: await hashFile(path.join(outputRoot, 'packs-manifest.tsv')),
  }, null, 2) + '\n');
  console.error((planOnly ? 'Planned' : 'Built') + ' packed release ' + release + ': ' + genomes.length + ' genomes, ' + (logicalRows.length - 1) + ' logical files, ' + physicalPacks.length + ' packs');
  return { outputRoot, genomes: genomes.length, logicalFiles: logicalRows.length - 1, packs: physicalPacks.length, planOnly };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  await buildPackedRelease({ projectRoot, ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
