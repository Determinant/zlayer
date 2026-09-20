import { hasJsonReferenceIdentity } from '../json-reference.js';
import type { ProcedureAirport, ProcedureCatalog, ProcedureKind, ProcedureRecord, ProcedureResourceRecord, ProcedureVolume, ProcedureVolumeTarget } from '../types.js';
import { isRecord, isNonEmptyString, isNonNegativeInteger, isPositiveInteger, isCycle, isSha256, isStringRecord, isOptionalNullableString, hasValidDate, isIsoDate, hasUniqueStrings } from '../validation.js';

export function isProcedureCatalog(
  value: unknown,
  expectedEffectiveDate?: string,
): value is ProcedureCatalog {
  if (!isRecord(value) || !isRecord(value.sourceXml)) return false;
  if (
    value.schemaVersion !== 1 ||
    !isNonNegativeInteger(value.builderVersion) ||
    !isCycle(value.cycle) ||
    !isIsoDate(value.effectiveDate) ||
    (expectedEffectiveDate !== undefined && value.effectiveDate !== expectedEffectiveDate) ||
    !isIsoDate(value.expirationDate) ||
    value.effectiveDate >= value.expirationDate ||
    !isNonEmptyString(value.generatedAt) ||
    !hasValidDate(value.generatedAt) ||
    !isNonEmptyString(value.faaPdfBaseUrl) ||
    !isNonEmptyString(value.sourceXml.url) ||
    !isSha256(value.sourceXml.sha256) ||
    !Array.isArray(value.volumes) ||
    !value.volumes.every(isProcedureVolume) ||
    !hasUniqueStrings(value.volumes.map((volume) => volume.id)) ||
    !Array.isArray(value.airports) ||
    !value.airports.every(isProcedureAirport) ||
    !hasUniqueStrings(value.airports.map((airport) => airport.id))
  ) {
    return false;
  }
  const procedureIds = value.airports.flatMap((airport) =>
    airport.procedures.map((procedure) => procedure.id)
  );
  if (!hasUniqueStrings(procedureIds)) return false;

  const volumes = new Map(value.volumes.map((volume) => [volume.id, volume]));
  const targetCounts = new Map<string, { resolved: number; unresolved: number }>();
  for (const procedure of value.airports.flatMap((airport) => airport.procedures)) {
    const target = procedure.volumeTarget;
    if (!target) continue;
    const volume = volumes.get(target.volumeId);
    if (target.pageIndex !== null && (!volume || target.pageIndex >= volume.pageCount)) {
      return false;
    }
    if (!volume) continue;
    const counts = targetCounts.get(volume.id) ?? { resolved: 0, unresolved: 0 };
    if (target.pageIndex === null) counts.unresolved += 1;
    else counts.resolved += 1;
    targetCounts.set(volume.id, counts);
  }
  return value.volumes.every((volume) => {
    const counts = targetCounts.get(volume.id) ?? { resolved: 0, unresolved: 0 };
    return volume.resolvedTargetCount === counts.resolved &&
      volume.unresolvedTargetCount === counts.unresolved;
  });
}

export function isProcedureResourceRecord(value: unknown): value is ProcedureResourceRecord {
  return isRecord(value) &&
    value.id === 'procedures' &&
    isNonEmptyString(value.title) &&
    isCycle(value.cycle) &&
    isIsoDate(value.effectiveDate) &&
    isIsoDate(value.expirationDate) &&
    value.effectiveDate < value.expirationDate &&
    isNonNegativeInteger(value.airportCount) &&
    isNonNegativeInteger(value.sourceAirportCount) &&
    value.airportCount <= value.sourceAirportCount &&
    isNonNegativeInteger(value.procedureCount) &&
    isNonNegativeInteger(value.sourceProcedureCount) &&
    value.procedureCount <= value.sourceProcedureCount &&
    isNonEmptyString(value.url) &&
    hasJsonReferenceIdentity(value);
}

export function isProcedureAirport(value: unknown): value is ProcedureAirport {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.faaId) &&
    isOptionalNullableString(value.icaoId) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.city) &&
    isNonEmptyString(value.state) &&
    isNonEmptyString(value.volumeId) &&
    typeof value.military === 'boolean' &&
    typeof value.sortCode === 'string' &&
    Array.isArray(value.procedures) &&
    value.procedures.every(isProcedureRecord) &&
    hasUniqueStrings(value.procedures.map((procedure) => procedure.id));
}

export function isProcedureRecord(value: unknown): value is ProcedureRecord {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  return isNonEmptyString(value.id) &&
    typeof value.kind === 'string' &&
    PROCEDURE_KINDS.has(value.kind as ProcedureKind) &&
    isNonEmptyString(value.name) &&
    isNonNegativeInteger(value.sortOrder) &&
    isNonEmptyString(value.pdfName) &&
    isNonEmptyString(value.pdfUrl) &&
    isOptionalNullableString(value.namedDestination) &&
    (value.volumeTarget === null || isProcedureVolumeTarget(value.volumeTarget)) &&
    [
      value.source.chartSequence,
      value.source.chartCode,
    ].every(isNonEmptyString) &&
    [
      value.source.userAction,
      value.source.changeNoticeFlag,
      value.source.changeNoticeSection,
      value.source.changeNoticePage,
      value.source.procedureId,
      value.source.twoColored,
      value.source.civil,
      value.source.faaComputerCode,
      value.source.copter,
      value.source.amendmentNumber,
      value.source.amendmentDate,
    ].every(isOptionalNullableString) &&
    isStringRecord(value.source.extraFields);
}

export function isProcedureVolumeTarget(value: unknown): value is ProcedureVolumeTarget {
  return isRecord(value) &&
    isNonEmptyString(value.volumeId) &&
    isOptionalNullableString(value.section) &&
    isOptionalNullableString(value.printedPage) &&
    (value.pageIndex === null || isNonNegativeInteger(value.pageIndex));
}

export function isProcedureVolume(value: unknown): value is ProcedureVolume {
  return isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.url) &&
    isPositiveInteger(value.byteLength) &&
    isSha256(value.sha256) &&
    isPositiveInteger(value.pageCount) &&
    isNonNegativeInteger(value.resolvedTargetCount) &&
    isNonNegativeInteger(value.unresolvedTargetCount);
}

const PROCEDURE_KINDS = new Set<ProcedureKind>([
  'airport-diagram',
  'approach',
  'departure',
  'arrival',
  'takeoff-minimums',
  'diverse-vector-area',
  'alternate-minimums',
  'radar-minimums',
  'hot-spot',
  'lahso',
  'other',
]);
