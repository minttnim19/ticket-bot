import { Locator, Page } from "playwright";

export type SeatRetryOptions = {
  zonePreference: string[];
  zoneTypePreference?: ZoneTypePreference;
  currentZoneHint?: string;
  seatRowPreference?: string[];
  preferredSeats?: string[];
  seatSelectionStrategy?: SeatSelectionStrategy;
  desiredSeatCount: number;
  requireAdjacent: boolean;
  allowFallbackAnySeat: boolean;
  allowFallbackAnyZone: boolean;
  maxRetries: number;
  adjacentRetryRounds?: number;
  retryIntervalMs: number;
  onZoneOrder?: (strategy: SeatSelectionStrategy, zoneNames: string[]) => void;
};

export type SeatSelectionStrategy =
  | "default"
  | "closest-stage"
  | "center-most"
  | "front-left"
  | "front-right"
  | "back-left"
  | "back-right";

export type ZoneTypePreference = "both" | "standing-only" | "seating-only";

type SeatCandidate = {
  row: string;
  rowOrder: number;
  number: number;
  locatorSelector: string;
  label: string;
};

type ZoneCandidateMeta = {
  locator: Locator;
  zoneName: string;
  tagName: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
  domIndex: number;
};

const unavailablePatterns = [
  { label: "coming soon", pattern: /coming\s*soon/i },
  { label: "temporarily unavailable", pattern: /temporarily\s*unavailable/i },
  { label: "not available", pattern: /not\s*available/i },
  { label: "หมด", pattern: /หมด/i },
  { label: "ยังไม่เปิด", pattern: /ยังไม่เปิด/i },
] as const;
const zoneSuffixPattern = /#([A-Z0-9]+)$/i;
const seatTitlePattern = /^([A-Z]+)-(\d+)$/i;

async function firstVisibleLocator(
  candidates: Locator[],
): Promise<Locator | null> {
  for (const candidate of candidates) {
    if (await candidate.count()) {
      const first = candidate.first();
      if (await first.isVisible().catch(() => false)) {
        return first;
      }
    }
  }
  return null;
}

export async function readPageText(page: Page): Promise<string> {
  const text = await page.locator("body").innerText().catch(() => "");
  return text.replaceAll(/\s+/g, " ").trim();
}

export async function pageLooksUnavailable(page: Page): Promise<boolean> {
  return Boolean(await findUnavailableReason(page));
}

export async function findUnavailableReason(page: Page): Promise<string | null> {
  const text = await readPageText(page);
  const matched = unavailablePatterns.find(({ pattern }) => pattern.test(text));
  return matched ? matched.label : null;
}

async function triggerImageMapZone(zoneOption: Locator): Promise<boolean> {
  const triggered = await zoneOption
    .evaluate((node) => {
      const area = node as any;
      const href = area.getAttribute("href") ?? "";
      const win = globalThis as any;
      const clickEvent = new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: win,
      });

      if (typeof win.selectzone === "function") {
        win.selectzone(href, clickEvent);
        return true;
      }

      area.dispatchEvent(clickEvent);
      area.click();
      return true;
    })
    .catch(() => false);

  return triggered;
}

async function waitForZoneTransition(page: Page): Promise<void> {
  const currentUrl = page.url();
  await Promise.race([
    page.waitForURL(
      (url) =>
        url.toString() !== currentUrl &&
        /fixed\.php|festival\.php|verify\.php|signin\.php|zones\.php/i.test(url.toString()),
      { timeout: 5_000 },
    ),
    page.locator("#tableseats, #popup-signin, form[action*='verify']").first().waitFor({
      state: "attached",
      timeout: 5_000,
    }),
    page.waitForTimeout(280),
  ]).catch(() => undefined);
}

async function clickZoneLocator(zoneOption: Locator): Promise<boolean> {
  const tagName = await zoneOption
    .evaluate((node) => node.tagName.toLowerCase())
    .catch(() => "");

  if (tagName === "option") {
    const value = await zoneOption.getAttribute("value");
    if (value) {
      const select = zoneOption.locator("xpath=ancestor::select[1]");
      await select.selectOption(value).catch(() => undefined);
      return true;
    }
    return false;
  }

  if (tagName === "area") {
    const triggered = await triggerImageMapZone(zoneOption);
    return triggered;
  }

  await zoneOption.click({ timeout: 3_000 }).catch(() => undefined);
  return true;
}

async function matchesZoneTypePreference(
  zoneOption: Locator,
  zoneTypePreference: ZoneTypePreference,
): Promise<boolean> {
  if (zoneTypePreference === "both") {
    return true;
  }

  const href = (await zoneOption.getAttribute("href").catch(() => ""))?.toLowerCase() ?? "";
  if (!href) {
    return true;
  }

  if (zoneTypePreference === "standing-only") {
    return href.includes("#festival.php#");
  }

  if (zoneTypePreference === "seating-only") {
    return href.includes("#fixed.php#");
  }

  return true;
}

async function inferZoneName(zoneOption: Locator): Promise<string | null> {
  const href = await zoneOption.getAttribute("href").catch(() => null);
  if (href) {
    const match = zoneSuffixPattern.exec(href);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  const dataZone = await zoneOption
    .evaluate((node) => {
      const element = node as { dataset?: { zone?: string } };
      return element.dataset?.zone ?? null;
    })
    .catch(() => null);
  if (dataZone) {
    return dataZone.trim().toUpperCase();
  }

  const text = (await zoneOption.textContent().catch(() => ""))?.trim();
  return text ? text.toUpperCase() : null;
}

async function readZoneGeometry(zoneOption: Locator): Promise<{
  tagName: string;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
}> {
  return zoneOption
    .evaluate((node) => {
      const element = node as {
        tagName: string;
        getAttribute: (name: string) => string | null;
        getBoundingClientRect?: () => {
          left: number;
          right: number;
          top: number;
          bottom: number;
          width: number;
          height: number;
        };
      };
      const tagName = element.tagName.toLowerCase();

      if (tagName === "area") {
        const coordsText = element.getAttribute("coords") ?? "";
        const values = coordsText
          .split(",")
          .map((value) => Number.parseFloat(value.trim()))
          .filter((value) => Number.isFinite(value));
        const xs = values.filter((_, index) => index % 2 === 0);
        const ys = values.filter((_, index) => index % 2 === 1);
        const minX = xs.length ? Math.min(...xs) : 0;
        const maxX = xs.length ? Math.max(...xs) : 0;
        const minY = ys.length ? Math.min(...ys) : 0;
        const maxY = ys.length ? Math.max(...ys) : 0;
        return {
          tagName,
          minX,
          maxX,
          minY,
          maxY,
          centerX: (minX + maxX) / 2,
          centerY: (minY + maxY) / 2,
        };
      }

      const rect = element.getBoundingClientRect?.();
      const minX = rect?.left ?? 0;
      const maxX = rect?.right ?? 0;
      const minY = rect?.top ?? 0;
      const maxY = rect?.bottom ?? 0;
      return {
        tagName,
        minX,
        maxX,
        minY,
        maxY,
        centerX: rect ? minX + rect.width / 2 : 0,
        centerY: rect ? minY + rect.height / 2 : 0,
      };
    })
    .catch(() => ({
      tagName: "",
      minX: 0,
      maxX: 0,
      minY: 0,
      maxY: 0,
      centerX: 0,
      centerY: 0,
    }));
}

function compareZoneCandidates(
  left: ZoneCandidateMeta,
  right: ZoneCandidateMeta,
  strategy: SeatSelectionStrategy,
  mapCenterX: number,
): number {
  const leftCenterDistance = Math.abs(left.centerX - mapCenterX);
  const rightCenterDistance = Math.abs(right.centerX - mapCenterX);

  if (strategy === "closest-stage") {
    if (left.minY !== right.minY) {
      return left.minY - right.minY;
    }
    if (leftCenterDistance !== rightCenterDistance) {
      return leftCenterDistance - rightCenterDistance;
    }
    return left.domIndex - right.domIndex;
  }

  if (strategy === "center-most") {
    if (leftCenterDistance !== rightCenterDistance) {
      return leftCenterDistance - rightCenterDistance;
    }
    if (left.minY !== right.minY) {
      return left.minY - right.minY;
    }
    return left.domIndex - right.domIndex;
  }

  if (strategy === "front-left") {
    if (left.minY !== right.minY) {
      return left.minY - right.minY;
    }
    if (left.centerX !== right.centerX) {
      return left.centerX - right.centerX;
    }
    return left.domIndex - right.domIndex;
  }

  if (strategy === "front-right") {
    if (left.minY !== right.minY) {
      return left.minY - right.minY;
    }
    if (left.centerX !== right.centerX) {
      return right.centerX - left.centerX;
    }
    return left.domIndex - right.domIndex;
  }

  if (strategy === "back-left") {
    if (left.maxY !== right.maxY) {
      return right.maxY - left.maxY;
    }
    if (left.centerX !== right.centerX) {
      return left.centerX - right.centerX;
    }
    return left.domIndex - right.domIndex;
  }

  if (strategy === "back-right") {
    if (left.maxY !== right.maxY) {
      return right.maxY - left.maxY;
    }
    if (left.centerX !== right.centerX) {
      return right.centerX - left.centerX;
    }
    return left.domIndex - right.domIndex;
  }

  return left.domIndex - right.domIndex;
}

async function collectZoneCandidates(
  page: Page,
  zoneTypePreference: ZoneTypePreference,
  excludedZones: string[],
): Promise<ZoneCandidateMeta[]> {
  const candidateGroups = [
    page.locator('map area[href*="#fixed.php#"], map area[href*="#festival.php#"]'),
    page.locator("[data-zone]"),
    page.locator("button[data-zone]"),
    page.locator("a[data-zone]"),
  ];
  const candidates: ZoneCandidateMeta[] = [];
  let domIndex = 0;

  for (const candidateGroup of candidateGroups) {
    const count = await candidateGroup.count();
    for (let index = 0; index < count; index += 1) {
      const locator = candidateGroup.nth(index);
      const zoneName = await inferZoneName(locator);
      if (!zoneName || excludedZones.includes(zoneName)) {
        continue;
      }

      if (!(await matchesZoneTypePreference(locator, zoneTypePreference))) {
        continue;
      }

      const geometry = await readZoneGeometry(locator);
      candidates.push({
        locator,
        zoneName,
        domIndex,
        ...geometry,
      });
      domIndex += 1;
    }
  }

  return candidates;
}

export async function choosePreferredZone(
  page: Page,
  zonePreference: string[],
  zoneTypePreference: ZoneTypePreference = "both",
  excludedZones: string[] = [],
): Promise<string | null> {
  for (const zoneName of zonePreference) {
    if (excludedZones.includes(zoneName.toUpperCase())) {
      continue;
    }

    const imageMapZone = page.locator(
      `map area[href$="#${zoneName}"], map area[href*="#${zoneName}"]`,
    );
    if (await imageMapZone.count()) {
      const zoneLocator = imageMapZone.first();
      if (!(await matchesZoneTypePreference(zoneLocator, zoneTypePreference))) {
        continue;
      }
      const clicked = await clickZoneLocator(zoneLocator);
      if (clicked) {
        await waitForZoneTransition(page);
        return zoneName.toUpperCase();
      }
    }

    const zoneOption = await firstVisibleLocator([
      page.locator(`option:has-text("${zoneName}")`),
      page.locator(`label:has-text("${zoneName}")`),
      page.locator(`button:has-text("${zoneName}")`),
      page.locator(`a:has-text("${zoneName}")`),
      page.locator(`[data-zone*="${zoneName}"]`),
      page.getByText(zoneName, { exact: false }),
    ]);

    if (!zoneOption) {
      continue;
    }

    if (!(await matchesZoneTypePreference(zoneOption, zoneTypePreference))) {
      continue;
    }

    if (await clickZoneLocator(zoneOption)) {
      await waitForZoneTransition(page);
      return zoneName.toUpperCase();
    }
  }

  return null;
}

export async function chooseAnyZone(
  page: Page,
  zoneTypePreference: ZoneTypePreference = "both",
  excludedZones: string[] = [],
  seatSelectionStrategy: SeatSelectionStrategy = "default",
  onZoneOrder?: (strategy: SeatSelectionStrategy, zoneNames: string[]) => void,
): Promise<string | null> {
  const candidates = await collectZoneCandidates(page, zoneTypePreference, excludedZones);
  const xs = candidates.flatMap((candidate) => [candidate.minX, candidate.maxX]);
  const mapCenterX = xs.length
    ? (Math.min(...xs) + Math.max(...xs)) / 2
    : Number.POSITIVE_INFINITY;
  const sortedCandidates =
    seatSelectionStrategy === "default"
      ? candidates
      : [...candidates].sort((left, right) =>
          compareZoneCandidates(left, right, seatSelectionStrategy, mapCenterX),
        );
  onZoneOrder?.(
    seatSelectionStrategy,
    sortedCandidates.map((candidate) => candidate.zoneName),
  );

  for (const candidate of sortedCandidates) {
    const clicked = await clickZoneLocator(candidate.locator);
    if (clicked) {
      await waitForZoneTransition(page);
      return candidate.zoneName;
    }
  }

  return null;
}

export async function countSelectableZones(
  page: Page,
  zoneTypePreference: ZoneTypePreference = "both",
  preferredZones: string[] = [],
): Promise<number> {
  const candidates = [
    page.locator('map area[href*="#fixed.php#"], map area[href*="#festival.php#"]'),
    page.locator("[data-zone]"),
    page.locator("button[data-zone]"),
    page.locator("a[data-zone]"),
  ];
  const preferredZoneSet = new Set(preferredZones.map((zone) => zone.trim().toUpperCase()).filter(Boolean));
  const matched = new Set<string>();

  for (const candidateGroup of candidates) {
    const count = await candidateGroup.count();
    for (let index = 0; index < count; index += 1) {
      const zoneOption = candidateGroup.nth(index);
      const zoneName = await inferZoneName(zoneOption);
      if (!zoneName) {
        continue;
      }

      if (preferredZoneSet.size > 0 && !preferredZoneSet.has(zoneName)) {
        continue;
      }

      if (!(await matchesZoneTypePreference(zoneOption, zoneTypePreference))) {
        continue;
      }

      matched.add(zoneName);
    }
  }

  return matched.size;
}

function parseSeatTitle(title: string): { row: string; number: number } | null {
  const match = seatTitlePattern.exec(title);
  if (!match) {
    return null;
  }

  return {
    row: match[1].toUpperCase(),
    number: Number(match[2]),
  };
}

async function collectSeatCandidates(page: Page): Promise<SeatCandidate[]> {
  const cells = page.locator("#tableseats td[title]:not(.not-available)");
  const count = await cells.count();
  const seats: SeatCandidate[] = [];
  const rowOrderByName = new Map<string, number>();

  for (let index = 0; index < count; index += 1) {
    const cell = cells.nth(index);
    const title = await cell.getAttribute("title");
    if (!title) {
      continue;
    }

    const parsed = parseSeatTitle(title);
    if (!parsed) {
      continue;
    }

    const seatButton = cell.locator("div.seatuncheck");
    if (!(await seatButton.count())) {
      continue;
    }

    const seatId = await seatButton.first().getAttribute("id");
    if (!seatId) {
      continue;
    }

    if (!rowOrderByName.has(parsed.row)) {
      rowOrderByName.set(parsed.row, rowOrderByName.size);
    }

    seats.push({
      row: parsed.row,
      rowOrder: rowOrderByName.get(parsed.row) ?? 0,
      number: parsed.number,
      locatorSelector: `#${seatId}`,
      label: `${parsed.row}-${parsed.number}`,
    });
  }

  return seats;
}

async function clickSeatSet(page: Page, seats: SeatCandidate[]): Promise<boolean> {
  for (const seat of seats) {
    await page.locator(seat.locatorSelector).click({ timeout: 3_000 }).catch(() => undefined);
    await page.waitForTimeout(80);
  }
  return seats.length > 0;
}

function pickExactSeats(
  seats: SeatCandidate[],
  preferredSeats: string[],
): SeatCandidate[] | null {
  if (!preferredSeats.length) {
    return null;
  }

  const normalized = preferredSeats.map((seat) => seat.trim().toUpperCase());
  const picked = normalized
    .map((label) => seats.find((seat) => seat.label.toUpperCase() === label))
    .filter((seat): seat is SeatCandidate => Boolean(seat));

  return picked.length === normalized.length ? picked : null;
}

function isFrontToBack(strategy: SeatSelectionStrategy): boolean {
  return strategy === "front-left" || strategy === "front-right";
}

function isLeftToRight(strategy: SeatSelectionStrategy): boolean {
  return strategy === "front-left" || strategy === "back-left";
}

function buildRowSequence(
  seats: SeatCandidate[],
  rowPreference: string[],
  strategy: SeatSelectionStrategy,
): string[] {
  if (strategy === "default") {
    return rowPreference.length
      ? rowPreference
      : [...new Set(seats.map((seat) => seat.row))];
  }

  const uniqueRows = [...new Map(seats.map((seat) => [seat.row, seat.rowOrder])).entries()]
    .sort((left, right) =>
      isFrontToBack(strategy) ? left[1] - right[1] : right[1] - left[1],
    )
    .map(([row]) => row);

  return uniqueRows;
}

function sortSeatsInRow(
  seats: SeatCandidate[],
  strategy: SeatSelectionStrategy,
): SeatCandidate[] {
  const direction = isLeftToRight(strategy) ? 1 : -1;
  return seats.sort((left, right) => direction * (left.number - right.number));
}

function buildRowCenterMap(seats: SeatCandidate[]): Map<string, number> {
  const rowBounds = new Map<string, { min: number; max: number }>();
  for (const seat of seats) {
    const current = rowBounds.get(seat.row);
    if (!current) {
      rowBounds.set(seat.row, { min: seat.number, max: seat.number });
      continue;
    }
    current.min = Math.min(current.min, seat.number);
    current.max = Math.max(current.max, seat.number);
  }

  return new Map(
    [...rowBounds.entries()].map(([row, bounds]) => [row, (bounds.min + bounds.max) / 2]),
  );
}

function getRowCenter(rowCenters: Map<string, number>, row: string): number {
  return rowCenters.get(row) ?? Number.POSITIVE_INFINITY;
}

function compareClosestStageSeatCandidates(
  left: SeatCandidate,
  right: SeatCandidate,
  rowCenters: Map<string, number>,
): number {
  if (left.rowOrder !== right.rowOrder) {
    return left.rowOrder - right.rowOrder;
  }

  const leftCenterDistance = Math.abs(left.number - getRowCenter(rowCenters, left.row));
  const rightCenterDistance = Math.abs(right.number - getRowCenter(rowCenters, right.row));
  if (leftCenterDistance !== rightCenterDistance) {
    return leftCenterDistance - rightCenterDistance;
  }

  if (left.number !== right.number) {
    return left.number - right.number;
  }

  return left.label.localeCompare(right.label);
}

function compareCenterMostSeatCandidates(
  left: SeatCandidate,
  right: SeatCandidate,
  rowCenters: Map<string, number>,
): number {
  const leftCenterDistance = Math.abs(left.number - getRowCenter(rowCenters, left.row));
  const rightCenterDistance = Math.abs(right.number - getRowCenter(rowCenters, right.row));
  if (leftCenterDistance !== rightCenterDistance) {
    return leftCenterDistance - rightCenterDistance;
  }

  if (left.rowOrder !== right.rowOrder) {
    return left.rowOrder - right.rowOrder;
  }

  if (left.number !== right.number) {
    return left.number - right.number;
  }

  return left.label.localeCompare(right.label);
}

function pickClosestStageAdjacentSeats(
  seats: SeatCandidate[],
  desiredSeatCount: number,
): SeatCandidate[] | null {
  const rowCenters = buildRowCenterMap(seats);
  const rows = [...new Map(seats.map((seat) => [seat.row, seat.rowOrder])).entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([row]) => row);

  let bestSlice: SeatCandidate[] | null = null;
  let bestScore:
    | {
        rowOrder: number;
        centerDistance: number;
        blockStart: number;
      }
    | null = null;

  for (const row of rows) {
    const rowSeats = [...seats]
      .filter((seat) => seat.row === row)
      .sort((left, right) => left.number - right.number);

    for (let index = 0; index <= rowSeats.length - desiredSeatCount; index += 1) {
      const slice = rowSeats.slice(index, index + desiredSeatCount);
      const isAdjacent = slice.every((seat, seatIndex) =>
        seatIndex === 0 ? true : slice[seatIndex - 1].number + 1 === seat.number,
      );
      if (!isAdjacent) {
        continue;
      }

      const lastSeat = slice.at(-1);
      if (!lastSeat) {
        continue;
      }
      const blockCenter = (slice[0].number + lastSeat.number) / 2;
      const score = {
        rowOrder: slice[0].rowOrder,
        centerDistance: Math.abs(blockCenter - getRowCenter(rowCenters, row)),
        blockStart: slice[0].number,
      };

      if (
        !bestScore ||
        score.rowOrder < bestScore.rowOrder ||
        (score.rowOrder === bestScore.rowOrder &&
          (score.centerDistance < bestScore.centerDistance ||
            (score.centerDistance === bestScore.centerDistance &&
              score.blockStart < bestScore.blockStart)))
      ) {
        bestSlice = slice;
        bestScore = score;
      }
    }
  }

  return bestSlice;
}

function pickCenterMostAdjacentSeats(
  seats: SeatCandidate[],
  desiredSeatCount: number,
): SeatCandidate[] | null {
  const rowCenters = buildRowCenterMap(seats);
  const rows = [...new Map(seats.map((seat) => [seat.row, seat.rowOrder])).entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([row]) => row);

  let bestSlice: SeatCandidate[] | null = null;
  let bestScore:
    | {
        centerDistance: number;
        rowOrder: number;
        blockStart: number;
      }
    | null = null;

  for (const row of rows) {
    const rowSeats = [...seats]
      .filter((seat) => seat.row === row)
      .sort((left, right) => left.number - right.number);

    for (let index = 0; index <= rowSeats.length - desiredSeatCount; index += 1) {
      const slice = rowSeats.slice(index, index + desiredSeatCount);
      const isAdjacent = slice.every((seat, seatIndex) =>
        seatIndex === 0 ? true : slice[seatIndex - 1].number + 1 === seat.number,
      );
      if (!isAdjacent) {
        continue;
      }

      const lastSeat = slice.at(-1);
      if (!lastSeat) {
        continue;
      }
      const blockCenter = (slice[0].number + lastSeat.number) / 2;
      const score = {
        centerDistance: Math.abs(blockCenter - getRowCenter(rowCenters, row)),
        rowOrder: slice[0].rowOrder,
        blockStart: slice[0].number,
      };

      if (
        !bestScore ||
        score.centerDistance < bestScore.centerDistance ||
        (score.centerDistance === bestScore.centerDistance &&
          (score.rowOrder < bestScore.rowOrder ||
            (score.rowOrder === bestScore.rowOrder &&
              score.blockStart < bestScore.blockStart)))
      ) {
        bestSlice = slice;
        bestScore = score;
      }
    }
  }

  return bestSlice;
}

function pickClosestStageSeatSet(
  seats: SeatCandidate[],
  desiredSeatCount: number,
): SeatCandidate[] | null {
  const rowCenters = buildRowCenterMap(seats);
  return [...seats]
    .sort((left, right) => compareClosestStageSeatCandidates(left, right, rowCenters))
    .slice(0, desiredSeatCount);
}

function pickCenterMostSeatSet(
  seats: SeatCandidate[],
  desiredSeatCount: number,
): SeatCandidate[] | null {
  const rowCenters = buildRowCenterMap(seats);
  return [...seats]
    .sort((left, right) => compareCenterMostSeatCandidates(left, right, rowCenters))
    .slice(0, desiredSeatCount);
}

function pickAdjacentSeats(
  seats: SeatCandidate[],
  desiredSeatCount: number,
  rowPreference: string[],
  strategy: SeatSelectionStrategy,
): SeatCandidate[] | null {
  if (strategy === "closest-stage") {
    return pickClosestStageAdjacentSeats(seats, desiredSeatCount);
  }

  if (strategy === "center-most") {
    return pickCenterMostAdjacentSeats(seats, desiredSeatCount);
  }

  const sortedRows = buildRowSequence(seats, rowPreference, strategy);

  for (const row of sortedRows) {
    const rowSeats = sortSeatsInRow(
      seats.filter((seat) => seat.row === row),
      strategy,
    );

    for (let index = 0; index <= rowSeats.length - desiredSeatCount; index += 1) {
      const slice = rowSeats.slice(index, index + desiredSeatCount);
      const isAdjacent = slice.every((seat, seatIndex) =>
        seatIndex === 0 ? true : Math.abs(seat.number - slice[seatIndex - 1].number) === 1,
      );
      if (isAdjacent) {
        return slice;
      }
    }
  }

  return null;
}

function pickSeatsByPreference(
  seats: SeatCandidate[],
  desiredSeatCount: number,
  rowPreference: string[],
  strategy: SeatSelectionStrategy,
): SeatCandidate[] | null {
  if (strategy === "closest-stage") {
    return pickClosestStageSeatSet(seats, desiredSeatCount);
  }

  if (strategy === "center-most") {
    return pickCenterMostSeatSet(seats, desiredSeatCount);
  }

  const rows = buildRowSequence(seats, rowPreference, strategy);

  for (const row of rows) {
    const rowSeats = sortSeatsInRow(
      seats.filter((seat) => seat.row === row),
      strategy,
    );
    if (rowSeats.length >= desiredSeatCount) {
      return rowSeats.slice(0, desiredSeatCount);
    }
  }

  return sortSeatsInRow([...seats], strategy).slice(0, desiredSeatCount);
}

export async function selectSeatSet(
  page: Page,
  options: Pick<
    SeatRetryOptions,
    | "preferredSeats"
    | "desiredSeatCount"
    | "requireAdjacent"
    | "seatRowPreference"
    | "seatSelectionStrategy"
    | "allowFallbackAnySeat"
  >,
): Promise<boolean> {
  const seats = await collectSeatCandidates(page);
  if (!seats.length) {
    return false;
  }

  const desiredCount = Math.max(1, options.desiredSeatCount);
  const preferredRows = options.seatRowPreference ?? [];
  const selectionStrategy = options.seatSelectionStrategy ?? "default";

  const exactSeats = pickExactSeats(seats, options.preferredSeats ?? []);
  if (exactSeats && exactSeats.length >= desiredCount) {
    return clickSeatSet(page, exactSeats.slice(0, desiredCount));
  }

  if (options.requireAdjacent && desiredCount > 1) {
    const adjacent = pickAdjacentSeats(
      seats,
      desiredCount,
      preferredRows,
      selectionStrategy,
    );
    if (adjacent) {
      return clickSeatSet(page, adjacent);
    }
    return false;
  }

  const preferredSet = pickSeatsByPreference(
    seats,
    desiredCount,
    preferredRows,
    selectionStrategy,
  );
  if (preferredSet?.length === desiredCount) {
    return clickSeatSet(page, preferredSet);
  }

  if (options.allowFallbackAnySeat) {
    return clickSeatSet(page, seats.slice(0, desiredCount));
  }

  return false;
}

export async function retrySeatSelection(
  page: Page,
  options: SeatRetryOptions,
): Promise<boolean> {
  const maxAttempts =
    options.requireAdjacent && options.desiredSeatCount > 1
      ? Math.min(options.maxRetries, options.adjacentRetryRounds ?? 5)
      : options.maxRetries;

  const exhaustedZones = new Set<string>();
  let activeZoneHint = options.currentZoneHint?.trim().toUpperCase() || null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let pickedZoneName: string | null = null;

    if (options.zonePreference.length) {
      pickedZoneName = await choosePreferredZone(
        page,
        options.zonePreference,
        options.zoneTypePreference,
        [...exhaustedZones],
      );
    }

    if (!pickedZoneName && options.allowFallbackAnyZone) {
      pickedZoneName = await chooseAnyZone(
        page,
        options.zoneTypePreference,
        [...exhaustedZones],
        options.seatSelectionStrategy ?? "default",
        options.onZoneOrder,
      );
    }

    if (pickedZoneName) {
      activeZoneHint = pickedZoneName;
      await page.waitForTimeout(70);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }

    const selected = await selectSeatSet(page, {
      preferredSeats: options.preferredSeats,
      desiredSeatCount: options.desiredSeatCount,
      requireAdjacent: options.requireAdjacent,
      seatRowPreference: options.seatRowPreference,
      seatSelectionStrategy: options.seatSelectionStrategy,
      allowFallbackAnySeat: options.allowFallbackAnySeat,
    });

    if (selected) {
      return true;
    }

    if (pickedZoneName) {
      exhaustedZones.add(pickedZoneName);
    } else if (activeZoneHint) {
      exhaustedZones.add(activeZoneHint);
    }

    if (await pageLooksUnavailable(page)) {
      return false;
    }

    const refreshControl = await firstVisibleLocator([
      page.getByRole("button", { name: /retry|refresh|search again|try again/i }),
      page.locator("button:has-text('Refresh')"),
      page.locator("button:has-text('Try Again')"),
      page.locator("a:has-text('Refresh')"),
      page.locator("a:has-text('เลือกโซนอื่น')"),
    ]);

    if (refreshControl) {
      await refreshControl.click({ timeout: 3_000 }).catch(() => undefined);
    } else {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    console.log(
      `Seat retry ${attempt}/${maxAttempts}: no seat set yet, exhausted zones=${[
        ...exhaustedZones,
      ].join(",") || "-"}, waiting ${options.retryIntervalMs}ms`,
    );
    await page.waitForTimeout(options.retryIntervalMs);
  }

  return false;
}
