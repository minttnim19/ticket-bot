import { Locator, Page } from "playwright";

export type SeatRetryOptions = {
  zonePreference: string[];
  currentZoneHint?: string;
  seatRowPreference?: string[];
  preferredSeats?: string[];
  desiredSeatCount: number;
  requireAdjacent: boolean;
  allowFallbackAnySeat: boolean;
  allowFallbackAnyZone: boolean;
  maxRetries: number;
  adjacentRetryRounds?: number;
  retryIntervalMs: number;
};

type SeatCandidate = {
  row: string;
  number: number;
  locatorSelector: string;
  label: string;
};

const unavailablePatterns = [
  { label: "coming soon", pattern: /coming\s*soon/i },
  { label: "temporarily unavailable", pattern: /temporarily\s*unavailable/i },
  { label: "not available", pattern: /not\s*available/i },
  { label: "หมด", pattern: /หมด/i },
  { label: "ยังไม่เปิด", pattern: /ยังไม่เปิด/i },
] as const;

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
  return text.replace(/\s+/g, " ").trim();
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
    page.waitForTimeout(350),
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

async function inferZoneName(zoneOption: Locator): Promise<string | null> {
  const href = await zoneOption.getAttribute("href").catch(() => null);
  if (href) {
    const match = href.match(/#([A-Z0-9]+)$/i);
    if (match) {
      return match[1].toUpperCase();
    }
  }

  const dataZone = await zoneOption.getAttribute("data-zone").catch(() => null);
  if (dataZone) {
    return dataZone.trim().toUpperCase();
  }

  const text = (await zoneOption.textContent().catch(() => ""))?.trim();
  return text ? text.toUpperCase() : null;
}

export async function choosePreferredZone(
  page: Page,
  zonePreference: string[],
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
      const clicked = await clickZoneLocator(imageMapZone.first());
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

    if (await clickZoneLocator(zoneOption)) {
      await waitForZoneTransition(page);
      return zoneName.toUpperCase();
    }
  }

  return null;
}

export async function chooseAnyZone(
  page: Page,
  excludedZones: string[] = [],
): Promise<string | null> {
  const candidates = [
    page.locator('map area[href*="#fixed.php#"], map area[href*="#festival.php#"]'),
    page.locator("[data-zone]"),
    page.locator("button[data-zone]"),
    page.locator("a[data-zone]"),
  ];

  for (const candidateGroup of candidates) {
    const count = await candidateGroup.count();
    for (let index = 0; index < count; index += 1) {
      const zoneOption = candidateGroup.nth(index);
      const zoneName = await inferZoneName(zoneOption);
      if (!zoneName) {
        continue;
      }
      if (zoneName && excludedZones.includes(zoneName)) {
        continue;
      }

      const tagName = await zoneOption
        .evaluate((node) => node.tagName.toLowerCase())
        .catch(() => "");

      if (tagName === "area") {
        const clicked = await clickZoneLocator(zoneOption);
        if (clicked) {
          await waitForZoneTransition(page);
          return zoneName;
        }
        continue;
      }

      const clicked = await clickZoneLocator(zoneOption);
      if (clicked) {
        await waitForZoneTransition(page);
        return zoneName;
      }
    }
  }

  return null;
}

function parseSeatTitle(title: string): { row: string; number: number } | null {
  const match = title.match(/^([A-Z]+)-(\d+)$/i);
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

    seats.push({
      row: parsed.row,
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
    await page.waitForTimeout(50);
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

function pickAdjacentSeats(
  seats: SeatCandidate[],
  desiredSeatCount: number,
  rowPreference: string[],
): SeatCandidate[] | null {
  const sortedRows = rowPreference.length
    ? rowPreference
    : [...new Set(seats.map((seat) => seat.row))];

  for (const row of sortedRows) {
    const rowSeats = seats
      .filter((seat) => seat.row === row)
      .sort((left, right) => left.number - right.number);

    for (let index = 0; index <= rowSeats.length - desiredSeatCount; index += 1) {
      const slice = rowSeats.slice(index, index + desiredSeatCount);
      const isAdjacent = slice.every((seat, seatIndex) =>
        seatIndex === 0 ? true : seat.number === slice[seatIndex - 1].number + 1,
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
): SeatCandidate[] | null {
  const rows = rowPreference.length
    ? rowPreference
    : [...new Set(seats.map((seat) => seat.row))];

  for (const row of rows) {
    const rowSeats = seats
      .filter((seat) => seat.row === row)
      .sort((left, right) => left.number - right.number);
    if (rowSeats.length >= desiredSeatCount) {
      return rowSeats.slice(0, desiredSeatCount);
    }
  }

  return seats
    .sort((left, right) => left.number - right.number)
    .slice(0, desiredSeatCount);
}

export async function selectSeatSet(
  page: Page,
  options: Pick<
    SeatRetryOptions,
    | "preferredSeats"
    | "desiredSeatCount"
    | "requireAdjacent"
    | "seatRowPreference"
    | "allowFallbackAnySeat"
  >,
): Promise<boolean> {
  const seats = await collectSeatCandidates(page);
  if (!seats.length) {
    return false;
  }

  const desiredCount = Math.max(1, options.desiredSeatCount);
  const preferredRows = options.seatRowPreference ?? [];

  const exactSeats = pickExactSeats(seats, options.preferredSeats ?? []);
  if (exactSeats && exactSeats.length >= desiredCount) {
    return clickSeatSet(page, exactSeats.slice(0, desiredCount));
  }

  if (options.requireAdjacent && desiredCount > 1) {
    const adjacent = pickAdjacentSeats(seats, desiredCount, preferredRows);
    if (adjacent) {
      return clickSeatSet(page, adjacent);
    }
    return false;
  }

  const preferredSet = pickSeatsByPreference(seats, desiredCount, preferredRows);
  if (preferredSet && preferredSet.length === desiredCount) {
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
        [...exhaustedZones],
      );
    }

    if (!pickedZoneName && options.allowFallbackAnyZone) {
      pickedZoneName = await chooseAnyZone(page, [...exhaustedZones]);
    }

    if (pickedZoneName) {
      activeZoneHint = pickedZoneName;
      await page.waitForTimeout(80);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }

    const selected = await selectSeatSet(page, {
      preferredSeats: options.preferredSeats,
      desiredSeatCount: options.desiredSeatCount,
      requireAdjacent: options.requireAdjacent,
      seatRowPreference: options.seatRowPreference,
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
