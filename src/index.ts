import { existsSync } from "fs";
import { createServer, IncomingMessage, ServerResponse, Server } from "http";
import { Browser, BrowserContext, chromium, Page } from "playwright";
import { concertConfig } from "./config";
import { loadEnvFile } from "./env";
import {
  chooseAnyZone,
  choosePreferredZone,
  findUnavailableReason,
  pageLooksUnavailable,
  readPageText,
  retrySeatSelection,
  type SeatSelectionStrategy,
} from "./seat";

type TicketStatus =
  | "coming_soon"
  | "on_sale"
  | "queue"
  | "sold_out"
  | "unknown";

type UserProfile = {
  email?: string;
  phone?: string;
};

type BotRunConfig = {
  eventUrl: string;
  roundText?: string;
  roundValue?: string;
  loginUsername?: string;
  loginPassword?: string;
  attendeeNames: string[];
  zonePreference: string[];
  preferredSeats: string[];
  seatSelectionStrategy: SeatSelectionStrategy;
  ticketQuantity: number;
  requireAdjacent: boolean;
  allowFallbackAny: boolean;
  verifyMethod?: "thaiid" | "passport";
  thaiId?: string;
  passportNumber?: string;
  passportCountry?: string;
};

type RoundOption = {
  venueText?: string;
  priceText?: string;
  dateText: string;
  timeText: string;
  label: string;
  isOpen: boolean;
  roundValue?: string;
};

type RoundHintsResponse = {
  rounds: RoundOption[];
  saleOpen: boolean;
  notice?: string;
};

type RunState = {
  state: "idle" | "running" | "done" | "error";
  message: string;
  config?: BotRunConfig;
};

type StatusReporter = (message: string) => void;

type PageMode =
  | "auto_round"
  | "auto_terms"
  | "auto_zone"
  | "auto_quantity"
  | "auto_seat"
  | "auto_enroll"
  | "auto_verify"
  | "auto_review"
  | "auto_queue"
  | "manual_login"
  | "manual_unknown";

type ManualPageMode = Extract<PageMode, `manual_${string}`>;

class TicketAssistBot {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private lastSelectedZone: string | null = null;
  private keepBrowserOpen = false;

  constructor(
    private readonly runtimeConfig: BotRunConfig,
    private readonly reportStatus?: StatusReporter,
  ) {}

  private updateStatus(message: string) {
    console.log(message);
    this.reportStatus?.(message);
  }

  private isDebugEnabled(): boolean {
    return /^(1|true|yes|on)$/i.test(process.env.DEBUG ?? "");
  }

  private debugStatus(message: string) {
    if (!this.isDebugEnabled()) {
      return;
    }
    this.updateStatus(message);
  }

  private isManualPageMode(mode: PageMode): mode is ManualPageMode {
    return mode.startsWith("manual_");
  }

  async init() {
    const browserChannel = process.env.BROWSER_CHANNEL || "chrome";
    const launchOptions = {
      headless: concertConfig.headless,
      channel: browserChannel,
      args: ["--disable-blink-features=AutomationControlled"],
    };

    try {
      this.browser = await chromium.launch(launchOptions);
      this.updateStatus(`Launched browser with channel: ${browserChannel}`);
    } catch (error) {
      this.updateStatus(
        `Failed to launch channel ${browserChannel}, falling back to Playwright Chromium`,
      );
      this.browser = await chromium.launch({
        headless: concertConfig.headless,
        args: ["--disable-blink-features=AutomationControlled"],
      });
    }

    this.context = await this.browser.newContext(
      existsSync(concertConfig.storageStatePath)
        ? { storageState: concertConfig.storageStatePath }
        : undefined,
    );
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(10_000);
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error("Bot not initialized");
    }
    return this.page;
  }

  async navigateToEvent() {
    const page = this.requirePage();
    await page.goto(this.runtimeConfig.eventUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    this.updateStatus(`Opened event page: ${this.runtimeConfig.eventUrl}`);
  }

  async navigateToIndex() {
    const page = this.requirePage();
    await page.goto("https://www.thaiticketmajor.com/index.html", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    this.updateStatus("Opened Thaiticketmajor homepage");
  }

  async isLoggedIn(): Promise<boolean> {
    const page = this.requirePage();
    const visibleLogout = page.locator('a[href="/user/logout.php"]:visible');
    if ((await visibleLogout.count()) > 0) {
      return true;
    }

    const visibleMemberBox = page.locator("#div_signout:visible");
    if ((await visibleMemberBox.count()) > 0) {
      return true;
    }

    const loginFormVisible = page.locator("#frm-signin:visible, #popup-signin:visible");
    if ((await loginFormVisible.count()) > 0) {
      return false;
    }

    return false;
  }

  hasLoginCredentials(): boolean {
    return Boolean(
      this.runtimeConfig.loginUsername?.trim() &&
        this.runtimeConfig.loginPassword?.trim(),
    );
  }

  getSigninUrl(): string {
    return `https://event.thaiticketmajor.com/user/signin.php?redir=${encodeURIComponent(
      this.runtimeConfig.eventUrl,
    )}`;
  }

  async openSigninPage() {
    const page = this.requirePage();
    await page.goto(this.getSigninUrl(), { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    this.updateStatus("Opened signin page");
  }

  async tryAutoLogin(): Promise<boolean> {
    if (!this.hasLoginCredentials()) {
      return false;
    }

    const page = this.requirePage();
    const username = this.runtimeConfig.loginUsername!.trim();
    const password = this.runtimeConfig.loginPassword!;
    const form = page.locator("#frm-signin-page, #frm-signin").first();

    if (!(await form.count())) {
      return false;
    }

    const usernameField = form.locator('input[name="username"], input[type="email"]').first();
    const passwordField = form.locator('input[name="password"], input[type="password"]').first();
    const submitButton = form.locator('button[type="submit"], .btn-signin').first();

    if (!(await usernameField.count()) || !(await passwordField.count())) {
      return false;
    }

    await usernameField.fill(username).catch(() => undefined);
    await passwordField.fill(password).catch(() => undefined);

    if (await page.locator("#redirURL").count()) {
      await page
        .locator("#redirURL")
        .evaluate(
          (node, value) => (((node as any).value = String(value)) as string),
          this.runtimeConfig.eventUrl,
        )
        .catch(() => undefined);
    }

    this.updateStatus("Submitting stored login credentials");
    await submitButton.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    await page.waitForTimeout(500).catch(() => undefined);

    if (await this.isLoggedIn()) {
      this.updateStatus("Auto login completed");
      return true;
    }

    const mode = await this.classifyCurrentPage();
    if (mode !== "manual_login") {
      this.updateStatus(`Auto login redirected to ${mode}`);
      return true;
    }

    this.updateStatus(
      "Auto login did not complete. Waiting for customer to correct login manually",
    );
    return false;
  }

  async ensureAuthenticatedSession() {
    await this.navigateToIndex();

    if (await this.isLoggedIn()) {
      this.updateStatus("Existing login session detected");
      return;
    }

    await this.openSigninPage();

    if (this.hasLoginCredentials()) {
      const autoLoggedIn = await this.tryAutoLogin();
      if (autoLoggedIn) {
        return;
      }
    }

    await this.waitForManualPageResolution("manual_login");
  }

  async detectTicketStatus(): Promise<TicketStatus> {
    const page = this.requirePage();
    const text = await readPageText(page);
    const roundButtons = page.locator(".box-event-list .body .row .col-btn a.btn");
    const roundButtonCount = await roundButtons.count();

    if (/queue|waiting room|ระบบคิว|รอรับคิว/i.test(text)) {
      return "queue";
    }

    if (/coming soon|เร็วๆนี้|เร็ว ๆ นี้|ยังไม่เปิด/i.test(text)) {
      return "coming_soon";
    }

    if (roundButtonCount > 0) {
      let hasOpenRound = false;
      let hasClosedRound = false;

      for (let index = 0; index < roundButtonCount; index += 1) {
        const button = roundButtons.nth(index);
        const buttonHtml = await button.evaluate((node) => node.outerHTML).catch(() => "");
        const isDisabled =
          (await button.getAttribute("disabled")) !== null ||
          /sold\s*out/i.test(buttonHtml) ||
          /disabled/i.test(buttonHtml);

        if (isDisabled) {
          hasClosedRound = true;
        } else {
          hasOpenRound = true;
        }
      }

      if (hasOpenRound) {
        return "on_sale";
      }

      if (hasClosedRound) {
        return "sold_out";
      }
    }

    if (/buy now|ซื้อบัตร|จองบัตร/i.test(text)) {
      return "on_sale";
    }

    if (/sold out|บัตรหมด/i.test(text)) {
      return "sold_out";
    }

    return "unknown";
  }

  async findMatchingRoundRow() {
    const page = this.requirePage();
    const rows = page.locator(".box-event-list .body .row");
    const rowCount = await rows.count();
    const desiredRound = this.runtimeConfig.roundText?.trim().toLowerCase();
    const desiredRoundValue = this.runtimeConfig.roundValue?.trim().toLowerCase();

    for (let index = 0; index < rowCount; index += 1) {
      const row = rows.nth(index);
      const action = row.locator(".col-btn a.btn").first();
      const rowHtml = await row.evaluate((node) => (node as any).outerHTML).catch(() => "");
      const dateText = (
        (await row.locator(".date").textContent().catch(() => "")) ?? ""
      ).trim();
      const timeText = (
        (await row.locator(".item-show").first().textContent().catch(() => "")) ?? ""
      ).trim();
      const venueText = (
        (await row
          .locator("xpath=ancestor::div[contains(@class,'event-detail-item')][1]//*[contains(@class,'venue')]")
          .first()
          .textContent()
          .catch(() => "")) ?? ""
      ).trim();
      const label = `${dateText} ${timeText}`.trim();
      const signature = [
        (await action.getAttribute("onclick").catch(() => "")) ?? "",
        (await action.getAttribute("href").catch(() => "")) ?? "",
        (await action.getAttribute("data-button").catch(() => "")) ?? "",
      ]
        .join(" ")
        .toLowerCase();

      let matches = false;
      if (desiredRoundValue) {
        matches = signature.includes(desiredRoundValue);
      }

      if (!matches && desiredRound) {
        const normalizedLabel = label.toLowerCase();
        matches =
          normalizedLabel.includes(desiredRound) ||
          timeText.toLowerCase().includes(desiredRound) ||
          venueText.toLowerCase().includes(desiredRound);
      }

      if (!matches && (desiredRound || desiredRoundValue)) {
        continue;
      }

      return {
        row,
        action,
        label,
        venueText,
        isOpen: rowLooksOpen(rowHtml),
      };
    }

    return null;
  }

  async selectPerformanceRoundIfPresent(): Promise<boolean> {
    const page = this.requirePage();
    const matchedRow = await this.findMatchingRoundRow();
    if (!matchedRow) {
      return false;
    }

    if (!matchedRow.isOpen) {
      this.updateStatus(
        `Selected event is not open yet: ${matchedRow.venueText ? `${matchedRow.venueText} / ` : ""}${matchedRow.label}`,
      );
      return false;
    }

    await matchedRow.action.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.updateStatus(
      `Selected performance round: ${matchedRow.venueText ? `${matchedRow.venueText} / ` : ""}${matchedRow.label}`,
    );
    return true;
  }

  async waitUntilSaleWindow() {
    const page = this.requirePage();
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      const matchedRound = await this.findMatchingRoundRow();
      if (matchedRound) {
        if (matchedRound.isOpen) {
          this.updateStatus(
            `Selected event is open: ${matchedRound.venueText ? `${matchedRound.venueText} / ` : ""}${matchedRound.label}`,
          );
          return "on_sale";
        }

        this.updateStatus(
          `Waiting on event page for sale to open: ${matchedRound.venueText ? `${matchedRound.venueText} / ` : ""}${matchedRound.label}`,
        );
      }

      const status = await this.detectTicketStatus();
      console.log(`Current event status: ${status}`);

      if (!matchedRound && (status === "on_sale" || status === "queue")) {
        return status;
      }

      if (!matchedRound && status === "sold_out") {
        throw new Error("Ticket status shows sold out");
      }

      if (status === "unknown") {
        this.updateStatus(
          "Event status is unknown. Waiting for customer to handle this page manually",
        );
        const resolvedMode = await this.waitForManualPageResolution("manual_unknown");

        if (resolvedMode === "auto_queue") {
          return "queue";
        }

        if (
          resolvedMode === "auto_zone" ||
          resolvedMode === "auto_quantity" ||
          resolvedMode === "auto_seat" ||
          resolvedMode === "auto_enroll" ||
          resolvedMode === "auto_review"
        ) {
          return "on_sale";
        }
      }

      await page.waitForTimeout(600);
      await page.reload({ waitUntil: "domcontentloaded" });
    }

    throw new Error("Timed out waiting for sale window");
  }

  async isSigninPage(): Promise<boolean> {
    const page = this.requirePage();
    const url = page.url();
    return /signin\.php/i.test(url);
  }

  async isVerifyPage(): Promise<boolean> {
    const page = this.requirePage();
    const url = page.url();
    if (/verify\.php/i.test(url)) {
      return true;
    }

    const text = await readPageText(page);
    return /ยืนยันตัวตนด้วยเลขบัตรประชาชน|ยืนยันตัวตนด้วยเลขพาสปอร์ต|กรุณากรอกข้อมูล/i.test(
      text,
    );
  }

  async isVerifyConditionPage(): Promise<boolean> {
    const page = this.requirePage();
    const url = page.url();
    if (/verify_condition\.php/i.test(url)) {
      this.debugStatus(`verify_condition page detected by URL: ${url}`);
      return true;
    }

    const checkboxCount = await page.locator("#rdagree, input[name='rdagree']").count();
    const verifyButtonCount = await page.locator("#btn_verify").count();
    if (checkboxCount > 0 || verifyButtonCount > 0) {
      this.debugStatus(
        `verify_condition element probe: rdagree=${checkboxCount}, btn_verify=${verifyButtonCount}, url=${url}`,
      );
    }

    return checkboxCount > 0 && verifyButtonCount > 0;
  }

  hasAutoVerifyProfile(): boolean {
    if (this.runtimeConfig.verifyMethod === "thaiid") {
      return Boolean(this.runtimeConfig.thaiId?.trim());
    }

    if (this.runtimeConfig.verifyMethod === "passport") {
      return Boolean(
        this.runtimeConfig.passportNumber?.trim() &&
          this.runtimeConfig.passportCountry?.trim(),
      );
    }

    return false;
  }

  getAttendeeNames(): string[] {
    return this.runtimeConfig.attendeeNames
      .map((name) => name.trim())
      .filter(Boolean);
  }

  async canAutoFillEnrollPage(): Promise<boolean> {
    const page = this.requirePage();
    const attendeeNames = this.getAttendeeNames();
    if (!attendeeNames.length) {
      return false;
    }

    const fullNameCount = await page.locator('input[name="txt_fullname[]"]:visible').count();
    if (fullNameCount > 0) {
      return attendeeNames.length >= fullNameCount;
    }

    const firstNameCount = await page.locator('input[name="txt_firstname[]"]:visible').count();
    const lastNameCount = await page.locator('input[name="txt_lastname[]"]:visible').count();
    const splitCount = Math.max(firstNameCount, lastNameCount);
    if (splitCount > 0) {
      return attendeeNames.length >= splitCount;
    }

    return false;
  }

  async isRateLimitVerificationPage(): Promise<boolean> {
    const page = this.requirePage();
    const text = await readPageText(page);
    return /verification required|your requests are too frequent|please input the verification code/i.test(
      text,
    );
  }

  async isSigninPopupVisible(): Promise<boolean> {
    const page = this.requirePage();
    return (await page.locator("#popup-signin:visible, #frm-signin:visible").count()) > 0;
  }

  async isReviewPage(): Promise<boolean> {
    const page = this.requirePage();
    const url = page.url();
    if (/enroll\.php/i.test(url)) {
      return false;
    }

    if (/paymentall\.php/i.test(url)) {
      return true;
    }

    if ((await page.locator("#btn_regnow, #register_data").count()) > 0) {
      return false;
    }

    if ((await page.locator("#booknow").count()) > 0) {
      return false;
    }

    if ((await page.locator(".booking-confirm").count()) > 0) {
      return true;
    }

    const text = await readPageText(page);
    return /ยืนยันการสั่งซื้อ|booking confirm|order summary|purchase summary/i.test(text);
  }

  async isQuantityPage(): Promise<boolean> {
    const page = this.requirePage();
    if ((await page.locator("#tableseats").count()) > 0) {
      return false;
    }

    if ((await page.locator('select[name="book_cnt"], #book_cnt').count()) === 0) {
      return false;
    }

    return (await page.locator("#booknow, #bookmnow").count()) > 0;
  }

  async isEnrollPage(): Promise<boolean> {
    const page = this.requirePage();
    const url = page.url();
    if (/enroll\.php/i.test(url)) {
      return true;
    }

    return (await page.locator("#btn_regnow, #register_data").count()) > 0;
  }

  async classifyCurrentPage(): Promise<PageMode> {
    const page = this.requirePage();

    if (await this.isSigninPage()) {
      return "manual_login";
    }

    if (await this.isSigninPopupVisible()) {
      return "manual_login";
    }

    if (await this.isVerifyConditionPage()) {
      return "auto_terms";
    }

    if (await this.isVerifyPage()) {
      return this.hasAutoVerifyProfile() ? "auto_verify" : "manual_unknown";
    }

    if (await this.isQuantityPage()) {
      return "auto_quantity";
    }

    if (await this.isSeatMapPage()) {
      return "auto_seat";
    }

    if (await this.isEnrollPage()) {
      return (await this.canAutoFillEnrollPage()) ? "auto_enroll" : "manual_unknown";
    }

    if (await this.isZonePage()) {
      return "auto_zone";
    }

    const roundRows = page.locator(".box-event-list .body .row");
    if ((await roundRows.count()) > 0) {
      return "auto_round";
    }

    if (await this.isReviewPage()) {
      return "auto_review";
    }

    const text = await readPageText(page);
    if (/queue|waiting room|ระบบคิว|รอรับคิว/i.test(text)) {
      return "auto_queue";
    }

    return "manual_unknown";
  }

  private statusForPageMode(mode: PageMode): string {
    switch (mode) {
      case "auto_round":
        return "Detected round selection page";
      case "auto_terms":
        return "Detected terms acceptance page";
      case "auto_zone":
        return "Detected zone selection page";
      case "auto_quantity":
        return "Detected quantity selection page";
      case "auto_seat":
        return "Detected seat selection page";
      case "auto_enroll":
        return "Detected attendee details page";
      case "auto_verify":
        return "Detected identity verification page";
      case "auto_review":
        return "Detected review page";
      case "auto_queue":
        return "Detected queue page";
      case "manual_login":
        return "Login is required, waiting for customer to log in manually";
      case "manual_unknown":
        return "Manual action is required on this page, waiting for customer to continue";
    }
  }

  async waitForManualPageResolution(mode: ManualPageMode) {
    const page = this.requirePage();
    this.updateStatus(this.statusForPageMode(mode));
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      const currentMode = await this.classifyCurrentPage();
      if (!this.isManualPageMode(currentMode)) {
        if (mode === "manual_login") {
          this.updateStatus("Manual login completed, returning to event page");
          await this.navigateToEvent();
          const eventMode = await this.classifyCurrentPage();
          this.updateStatus(`Returned to event page, current page: ${eventMode}`);
          return eventMode;
        }

        this.updateStatus(`Manual step completed, current page: ${currentMode}`);
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        return currentMode;
      }

      await page.waitForTimeout(1_000);
    }

    throw new Error(`Timed out waiting for manual step: ${mode}`);
  }

  async waitForManualLoginIfNeeded() {
    const page = this.requirePage();
    if (!(await this.isSigninPage()) && !(await this.isSigninPopupVisible())) {
      return false;
    }

    this.updateStatus("Login is required, waiting for customer to log in manually");
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      if (await this.isLoggedIn()) {
        this.updateStatus("Manual login completed, returning to event page");
        await this.navigateToEvent();
        return true;
      }

      const currentUrl = page.url();
      if (!/signin\.php/i.test(currentUrl) && (await this.isLoggedIn())) {
        this.updateStatus("Login redirect detected, returning to event page");
        await this.navigateToEvent();
        return true;
      }

      await page.waitForTimeout(1_000);
    }

    throw new Error("Timed out waiting for manual login");
  }

  async waitForManualVerificationIfNeeded() {
    const page = this.requirePage();
    if (!(await this.isVerifyPage())) {
      return false;
    }

    this.updateStatus("Verification is required, waiting for customer to complete manually");
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      if (!(await this.isVerifyPage())) {
        this.updateStatus("Manual verification completed, continuing booking flow");
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        return true;
      }

      await page.waitForTimeout(1_000);
    }

    throw new Error("Timed out waiting for manual verification");
  }

  async waitForManualRateLimitVerificationIfNeeded() {
    const page = this.requirePage();
    if (!(await this.isRateLimitVerificationPage())) {
      return false;
    }

    this.updateStatus(
      "Anti-bot verification is required, waiting for customer to complete manually",
    );
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      if (!(await this.isRateLimitVerificationPage())) {
        this.updateStatus("Anti-bot verification completed, continuing booking flow");
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        return true;
      }

      await page.waitForTimeout(1_000);
    }

    throw new Error("Timed out waiting for anti-bot verification");
  }

  async waitForPostRoundTransition() {
    const page = this.requirePage();
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      const mode = await this.classifyCurrentPage();
      if (this.isManualPageMode(mode)) {
        const resolvedMode = await this.waitForManualPageResolution(mode);
        if (resolvedMode === "auto_queue") {
          return "queue";
        }

        return "booking";
      }

      if (
        mode === "auto_terms" ||
        mode === "auto_zone" ||
        mode === "auto_seat" ||
        mode === "auto_review"
      ) {
        return "booking";
      }

      if (mode === "auto_queue") {
        return "queue";
      }

      await page.waitForTimeout(150);
    }

    return "unknown";
  }

  async enterQueueOrBuyFlow() {
    const page = this.requirePage();
    const buyButton = page
      .getByRole("link", { name: /buy now|ซื้อบัตร/i })
      .or(page.getByRole("button", { name: /buy now|ซื้อบัตร/i }))
      .or(page.locator("a:has-text('Buy Now')"))
      .or(page.locator("a:has-text('ซื้อบัตร')"));

    await buyButton.first().click();
    await page.waitForLoadState("domcontentloaded");
    this.updateStatus("Entered queue or purchase flow");
  }

  async handleQueueIfPresent() {
    const page = this.requirePage();
    const startedAt = Date.now();

    while (Date.now() - startedAt < concertConfig.waitForSaleMs) {
      if ((await this.classifyCurrentPage()) !== "auto_queue") {
        return;
      }

      this.updateStatus("Still in queue, waiting for the next page");
      await page.waitForTimeout(500);
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    }

    throw new Error("Queue wait timed out");
  }

  async fillKnownFields(profile: UserProfile) {
    const page = this.requirePage();

    if (profile.email) {
      const emailField = page.locator(
        'input[type="email"], input[name*="email"], input[id*="email"]',
      );
      if (await emailField.count()) {
        await emailField.first().fill(profile.email).catch(() => undefined);
      }
    }

    if (profile.phone) {
      const phoneField = page.locator(
        'input[name*="phone"], input[id*="phone"], input[type="tel"]',
      );
      if (await phoneField.count()) {
        await phoneField.first().fill(profile.phone).catch(() => undefined);
      }
    }
  }

  async selectRoundIfPresent() {
    const page = this.requirePage();
    const roundSelect = page.locator("#rdId");

    if (!(await roundSelect.count())) {
      return;
    }

    const currentValue = await roundSelect.inputValue().catch(() => "");
    let targetValue: string | undefined;

    if (this.runtimeConfig.roundValue) {
      targetValue = this.runtimeConfig.roundValue;
    } else if (this.runtimeConfig.roundText) {
      const options = roundSelect.locator("option");
      const optionCount = await options.count();
      for (let index = 0; index < optionCount; index += 1) {
        const option = options.nth(index);
        const label = (await option.textContent())?.trim() ?? "";
        const value = await option.getAttribute("value");
        if (
          value &&
          label.toLowerCase().includes(this.runtimeConfig.roundText.toLowerCase())
        ) {
          targetValue = value;
          break;
        }
      }
    } else if (concertConfig.roundValue) {
      targetValue = concertConfig.roundValue;
    }

    if (targetValue && targetValue !== currentValue) {
      await roundSelect.selectOption(targetValue).catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }

    const selectedRound = await roundSelect.inputValue().catch(() => "");
    this.updateStatus(`Selected round: ${selectedRound || "default"}`);
  }

  async selectTicketQuantity() {
    const page = this.requirePage();
    const quantity = Math.max(1, this.runtimeConfig.ticketQuantity);
    const quantitySelectors = [
      page.locator('select[name="book_cnt"]'),
      page.locator("#book_cnt"),
      page.locator('select[name*="qty"]'),
      page.locator('select[id*="qty"]'),
      page.locator('select[name*="ticket"]'),
      page.locator('select[id*="ticket"]'),
    ];

    for (const select of quantitySelectors) {
      if (await select.count()) {
        await select
          .first()
          .selectOption({ label: String(quantity) })
          .catch(async () => {
            await select
              .first()
              .selectOption(String(quantity))
              .catch(() => undefined);
          });
        this.updateStatus(`Requested ticket quantity: ${quantity}`);
        return;
      }
    }
  }

  async closeZoneAvailabilityPopupIfPresent() {
    const page = this.requirePage();
    const popup = page.locator("#popup-event-zone");
    const isPopupVisible = await popup
      .evaluate((node) => {
        const el = node as any;
        const style = el.ownerDocument.defaultView.getComputedStyle(el);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          el.offsetWidth > 0 &&
          el.offsetHeight > 0 &&
          el.innerHTML.trim().length > 0
        );
      })
      .catch(() => false);

    if (!isPopupVisible) {
      return;
    }

    const closeTrigger = popup.locator(
      [
        "#popup-event-zone .fancybox-close",
        "#popup-event-zone .btn-close",
        "#popup-event-zone [data-fancybox-close]",
        "#popup-event-zone .close",
        ".fancybox-close",
      ].join(", "),
    );

    if (await closeTrigger.count()) {
      await closeTrigger.first().click().catch(() => undefined);
    } else {
      await page.keyboard.press("Escape").catch(() => undefined);
      await page.locator("body").click({ position: { x: 20, y: 20 } }).catch(() => undefined);
    }

    await popup.waitFor({ state: "hidden", timeout: 3_000 }).catch(() => undefined);
    this.updateStatus("Closed zone availability popup");
  }

  async continuePastSelection() {
    const page = this.requirePage();
    const continueButton = page
      .getByRole("button", { name: /continue|next|confirm|ตกลง|ยืนยัน|ถัดไป/i })
      .or(page.getByRole("link", { name: /continue|next|confirm|ตกลง|ยืนยัน|ถัดไป/i }));

    if (await continueButton.count()) {
      await continueButton.first().click().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
  }

  async isZonePage(): Promise<boolean> {
    const page = this.requirePage();
    if (
      (await page.locator("#tableseats, #register_data, #btn_regnow, #rdagree, #btn_verify").count()) > 0
    ) {
      return false;
    }

    const url = page.url();
    if (/zones\.php/i.test(url)) {
      return true;
    }

    if ((await page.locator(".zone-container, .select-zone").count()) > 0) {
      return true;
    }

    return (await page.locator('map area[href*="#fixed.php#"], map area[href*="#festival.php#"]').count()) > 0;
  }

  async isSeatMapPage(): Promise<boolean> {
    const page = this.requirePage();
    return (await page.locator("#tableseats").count()) > 0;
  }

  async isRoundResetErrorPage(): Promise<boolean> {
    const page = this.requirePage();
    const text = await readPageText(page);
    return /please select round again from zone page|กรุณาเลือกรอบการแสดงใหม่จากหน้าโซน/i.test(
      text,
    );
  }

  async returnToZoneSelection() {
    const page = this.requirePage();
    const backToZone = page
      .locator('a[href*="/booking/3m/zones.php?query=445"]')
      .or(page.getByRole("link", { name: /เลือกโซนอื่น|ย้อนกลับ/i }));

    if (await backToZone.count()) {
      await backToZone.first().click().catch(() => undefined);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      return;
    }

    await page
      .goto("/booking/3m/zones.php?query=445", {
        waitUntil: "domcontentloaded",
      })
      .catch(() => undefined);
  }

  async confirmSelectedSeat(): Promise<boolean> {
    const page = this.requirePage();
    const confirmButton = page.locator("#booknow");

    if (!(await confirmButton.count())) {
      return false;
    }

    await confirmButton.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.updateStatus("Clicked confirm seat");
    return true;
  }

  async recoverFromRoundResetErrorIfNeeded(): Promise<boolean> {
    if (!(await this.isRoundResetErrorPage())) {
      return false;
    }

    this.updateStatus("Detected round reset error page, returning to zone selection");
    await this.returnToZoneSelection();
    return true;
  }

  async ensureZonePageReady() {
    await this.fillKnownFields({
      email: process.env.TTM_EMAIL,
      phone: process.env.TTM_PHONE,
    });
    await this.closeZoneAvailabilityPopupIfPresent();
  }

  async handleAutoRoundPage() {
    const selected = await this.selectPerformanceRoundIfPresent();
    if (!selected) {
      throw new Error("Selected event round is not ready to enter booking flow");
    }

    return this.waitForPostRoundTransition();
  }

  async handleAutoTermsPage() {
    const page = this.requirePage();
    const agreeCheckbox = page.locator("#rdagree, input[name='rdagree']").first();
    const verifyButton = page.locator("#btn_verify").first();
    const checkboxCount = await page.locator("#rdagree, input[name='rdagree']").count();
    const verifyButtonCount = await page.locator("#btn_verify").count();

    this.debugStatus(
      `Terms page controls: rdagree=${checkboxCount}, btn_verify=${verifyButtonCount}, url=${page.url()}`,
    );

    if (!(await agreeCheckbox.count()) || !(await verifyButton.count())) {
      throw new Error("Terms page is missing acceptance controls");
    }

    await agreeCheckbox.scrollIntoViewIfNeeded().catch(() => undefined);
    await agreeCheckbox.evaluate((node) => {
      const input = node as {
        checked: boolean;
        dispatchEvent: (event: Event) => boolean;
      };
      input.checked = true;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("click", { bubbles: true }));
    });
    const isChecked = await agreeCheckbox
      .evaluate((node) => Boolean((node as { checked?: boolean }).checked))
      .catch(() => false);
    this.debugStatus(`Accepted event terms and conditions (checked=${String(isChecked)})`);

    const currentUrl = page.url();
    await verifyButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await verifyButton.click({ force: true }).catch(async () => {
      await verifyButton.evaluate((node) => {
        (node as { click: () => void }).click();
      });
    });
    this.debugStatus(`Clicked Buy Ticket on terms page from url=${currentUrl}`);
    await Promise.race([
      page.waitForURL((url) => url.toString() !== currentUrl, { timeout: 5_000 }),
      page.waitForLoadState("domcontentloaded"),
    ]).catch(() => undefined);
    this.debugStatus(`Submitted terms acceptance, current url=${page.url()}`);
  }

  async handleAutoZonePage() {
    await this.ensureZonePageReady();

    const allowAnyZone =
      this.runtimeConfig.allowFallbackAny || this.runtimeConfig.zonePreference.length === 0;

    let zonePicked: string | null = null;
    if (this.runtimeConfig.zonePreference.length > 0) {
      zonePicked = await choosePreferredZone(this.requirePage(), this.runtimeConfig.zonePreference);
    }

    if (!zonePicked && allowAnyZone) {
      zonePicked = await chooseAnyZone(this.requirePage());
    }

    if (!zonePicked) {
      throw new Error("No matching zone could be selected");
    }

    this.lastSelectedZone = zonePicked;
    this.updateStatus(`Selected zone: ${zonePicked}, waiting for seat page`);
    await this.requirePage().waitForLoadState("domcontentloaded").catch(() => undefined);
  }

  async handleAutoSeatPage() {
    await this.selectTicketQuantity();

    const allowAnyZone =
      this.runtimeConfig.allowFallbackAny || this.runtimeConfig.zonePreference.length === 0;

    const seatSelected = await retrySeatSelection(this.requirePage(), {
      zonePreference: this.runtimeConfig.zonePreference,
      currentZoneHint: this.lastSelectedZone ?? undefined,
      seatRowPreference: concertConfig.seatRowPreference,
      preferredSeats: this.runtimeConfig.preferredSeats,
      seatSelectionStrategy: this.runtimeConfig.seatSelectionStrategy,
      desiredSeatCount: this.runtimeConfig.ticketQuantity,
      requireAdjacent: this.runtimeConfig.requireAdjacent,
      allowFallbackAnySeat: this.runtimeConfig.allowFallbackAny,
      allowFallbackAnyZone: allowAnyZone,
      maxRetries: concertConfig.maxRetries,
      adjacentRetryRounds: 5,
      retryIntervalMs: concertConfig.retryIntervalMs,
    });

    if (!seatSelected) {
      throw new Error("No seat found within retry limit");
    }

    const confirmed = await this.confirmSelectedSeat();
    if (!confirmed) {
      await this.continuePastSelection();
    }
  }

  async handleAutoQuantityPage() {
    await this.selectTicketQuantity();
    const page = this.requirePage();
    const confirmButton = page.locator("#booknow, #bookmnow").first();
    if (!(await confirmButton.count())) {
      throw new Error("Quantity page has no confirmation button");
    }

    await confirmButton.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.updateStatus("Confirmed quantity selection");
  }

  async handleAutoVerifyPage() {
    const page = this.requirePage();

    if (!(await this.isVerifyPage())) {
      return false;
    }

    const method = this.runtimeConfig.verifyMethod;
    if (!method) {
      return false;
    }

    const methodButton = page.locator(`.verify-method-btn[data-method="${method}"]`);
    if (await methodButton.count()) {
      await methodButton.first().click().catch(() => undefined);
      await page.waitForTimeout(250).catch(() => undefined);
    }

    await page
      .locator("#verify_method")
      .evaluate(
        (node, value) => (((node as any).value = String(value)) as string),
        method,
      )
      .catch(() => undefined);

    if (method === "passport") {
      const countryCode = this.runtimeConfig.passportCountry?.trim().toUpperCase();
      const passportNumber = this.runtimeConfig.passportNumber?.trim() ?? "";

      if (countryCode) {
        await page
          .locator("#passport_country")
          .evaluate(
            (node, value) => (((node as any).value = String(value)) as string),
            countryCode,
          )
          .catch(() => undefined);
        await page
          .locator("#passport_country_input")
          .fill(countryCode)
          .catch(() => undefined);
      }

      if (passportNumber) {
        await page.locator("#txt_verifycode").fill(passportNumber).catch(() => undefined);
      }
    } else {
      const thaiId = this.runtimeConfig.thaiId?.trim() ?? "";
      if (thaiId) {
        await page.locator("#txt_verifycode").fill(thaiId).catch(() => undefined);
      }
    }

    const verifySubmitButton = page.locator("#btnconfirm").first();
    await verifySubmitButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await verifySubmitButton.click({ force: true }).catch(async () => {
      await verifySubmitButton.evaluate((node) => {
        (node as { click: () => void }).click();
      });
    });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.updateStatus("Submitted identity verification form");
    return true;
  }

  async handleAutoEnrollPage() {
    const page = this.requirePage();
    const attendeeNames = this.getAttendeeNames();
    if (!attendeeNames.length) {
      return false;
    }

    const fullNameInputs = page.locator(
      'input[name="txt_fullname[]"]:visible, input[id^="txt_fullname_"]:visible',
    );
    const fullNameCount = await fullNameInputs.count();
    for (let index = 0; index < fullNameCount; index += 1) {
      const attendeeName = attendeeNames[index];
      if (!attendeeName) {
        continue;
      }
      await fullNameInputs.nth(index).fill(attendeeName).catch(() => undefined);
    }

    const firstNameInputs = page.locator(
      'input[name="txt_firstname[]"]:visible, input[id^="txt_firstname_"]:visible',
    );
    const firstNameCount = await firstNameInputs.count();
    for (let index = 0; index < firstNameCount; index += 1) {
      const attendeeName = attendeeNames[index];
      if (!attendeeName) {
        continue;
      }
      const parts = attendeeName.split(/\s+/).filter(Boolean);
      const firstName = parts.shift() ?? "";
      await firstNameInputs.nth(index).fill(firstName).catch(() => undefined);
    }

    const lastNameInputs = page.locator(
      'input[name="txt_lastname[]"]:visible, input[id^="txt_lastname_"]:visible',
    );
    const lastNameCount = await lastNameInputs.count();
    for (let index = 0; index < lastNameCount; index += 1) {
      const attendeeName = attendeeNames[index];
      if (!attendeeName) {
        continue;
      }
      const parts = attendeeName.split(/\s+/).filter(Boolean);
      const firstName = parts.shift() ?? "";
      const lastName = parts.join(" ") || firstName;
      await lastNameInputs.nth(index).fill(lastName).catch(() => undefined);
    }

    this.updateStatus(`Filled attendee details for ${attendeeNames.length} ticket holder(s)`);

    const enrollSubmitButton = page.locator("#btn_regnow").first();
    await enrollSubmitButton.scrollIntoViewIfNeeded().catch(() => undefined);
    await enrollSubmitButton.click({ force: true }).catch(async () => {
      await enrollSubmitButton.evaluate((node) => {
        (node as { click: () => void }).click();
      });
    });
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    this.updateStatus("Submitted attendee details form");
    return true;
  }

  async handleAutoReviewPage() {
    if (concertConfig.stopBeforePayment) {
      this.keepBrowserOpen = true;
      this.updateStatus(
        "Reached review page. Automation stopped before payment confirmation. Browser will stay open for manual payment.",
      );
      return true;
    }

    this.updateStatus(
      "Reached review page, but no auto-payment step is implemented.",
    );
    return true;
  }

  async run() {
    await this.ensureAuthenticatedSession();
    await this.navigateToEvent();

    const status = await this.waitUntilSaleWindow();

    for (
      let flowAttempt = 1;
      flowAttempt <= concertConfig.maxFlowRetries;
      flowAttempt += 1
    ) {
      this.updateStatus(`Seat flow attempt ${flowAttempt}/${concertConfig.maxFlowRetries}`);

      if (await this.recoverFromRoundResetErrorIfNeeded()) {
        continue;
      }

      let currentMode = await this.classifyCurrentPage();
      this.updateStatus(this.statusForPageMode(currentMode));

      if (status === "on_sale" && currentMode === "auto_round") {
        await this.handleAutoRoundPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (this.isManualPageMode(currentMode)) {
        currentMode = await this.waitForManualPageResolution(currentMode);
      }

      if (currentMode === "auto_queue") {
        await this.handleQueueIfPresent();
        currentMode = await this.classifyCurrentPage();
      }

      if (
        currentMode === "auto_zone" ||
        currentMode === "auto_quantity" ||
        currentMode === "auto_seat" ||
        currentMode === "auto_enroll" ||
        currentMode === "auto_review"
      ) {
        const unavailableReason = await findUnavailableReason(this.requirePage());
        if (unavailableReason) {
          throw new Error(
            `Purchase page reports unavailable tickets (${unavailableReason})`,
          );
        }
      }

      if (this.isManualPageMode(currentMode)) {
        currentMode = await this.waitForManualPageResolution(currentMode);
      }

      if (currentMode === "auto_round") {
        await this.handleAutoRoundPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_terms") {
        await this.handleAutoTermsPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_zone") {
        await this.handleAutoZonePage();
        currentMode = await this.classifyCurrentPage();
      }

      if (this.isManualPageMode(currentMode)) {
        currentMode = await this.waitForManualPageResolution(currentMode);
      }

      if (currentMode === "auto_queue") {
        await this.handleQueueIfPresent();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_verify") {
        await this.handleAutoVerifyPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_quantity") {
        await this.handleAutoQuantityPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_seat") {
        await this.handleAutoSeatPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (currentMode === "auto_enroll") {
        await this.handleAutoEnrollPage();
        currentMode = await this.classifyCurrentPage();
      }

      if (this.isManualPageMode(currentMode)) {
        currentMode = await this.waitForManualPageResolution(currentMode);
      }

      if (currentMode === "auto_review" && (await this.handleAutoReviewPage())) {
        return;
      }

      if (await this.recoverFromRoundResetErrorIfNeeded()) {
        await this.requirePage()
          .waitForTimeout(concertConfig.retryIntervalMs)
          .catch(() => undefined);
        continue;
      }

      const finalMode = await this.classifyCurrentPage();
      if (this.isManualPageMode(finalMode)) {
        await this.waitForManualPageResolution(finalMode);
        continue;
      }

      if (finalMode === "auto_zone") {
        this.updateStatus("Returned to zone page after seat confirmation, retrying flow");
        await this.requirePage()
          .waitForTimeout(concertConfig.retryIntervalMs)
          .catch(() => undefined);
        continue;
      }

      if (finalMode === "auto_review" && (await this.handleAutoReviewPage())) {
        return;
      }

      this.updateStatus(`Waiting for next known booking page, current page: ${finalMode}`);
      await this.requirePage()
        .waitForTimeout(concertConfig.retryIntervalMs)
        .catch(() => undefined);
    }

    throw new Error("Seat flow retry limit reached");
  }

  async close() {
    if (this.keepBrowserOpen) {
      return;
    }

    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
  }
}

const uiHtml = `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ticket Bot Control</title>
  <style>
    :root {
      --bg: #f5efe7;
      --panel: #fffdf9;
      --panel-soft: #f8f2eb;
      --line: #e7ddd1;
      --text: #201b17;
      --muted: #75685d;
      --accent: #c92312;
      --accent-dark: #961707;
      --success: #1d7a43;
      --warning: #9b6400;
      --danger: #b42318;
      --shadow: 0 18px 45px rgba(71, 45, 20, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(201, 35, 18, 0.10), transparent 26%),
        linear-gradient(180deg, #faf6f0 0%, #f2e8da 100%);
      color: var(--text);
      font-family: "Sukhumvit Set", "Noto Sans Thai", "SF Pro Display", sans-serif;
    }
    .wrap {
      max-width: 1180px;
      margin: 0 auto;
      padding: 32px 20px 72px;
    }
    .page-head {
      display: grid;
      gap: 10px;
      margin-bottom: 22px;
    }
    .eyebrow {
      display: inline-flex;
      width: fit-content;
      padding: 7px 12px;
      border-radius: 999px;
      background: rgba(201, 35, 18, 0.10);
      color: #8f2012;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .page-title {
      margin: 0;
      font-size: clamp(32px, 5vw, 56px);
      line-height: 0.98;
      letter-spacing: -0.04em;
      font-weight: 900;
    }
    .page-copy {
      margin: 0;
      color: var(--muted);
      max-width: 70ch;
      line-height: 1.6;
      font-size: 16px;
    }
    .layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 340px;
      gap: 20px;
      align-items: start;
    }
    .main-column {
      display: grid;
      gap: 18px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 26px;
      box-shadow: var(--shadow);
      padding: 22px;
    }
    .panel.soft {
      background: rgba(255, 251, 246, 0.84);
    }
    .section-head {
      display: grid;
      gap: 6px;
      margin-bottom: 16px;
    }
    .section-title {
      margin: 0;
      font-size: 20px;
      line-height: 1.1;
      font-weight: 900;
      letter-spacing: -0.02em;
    }
    .section-copy {
      margin: 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .form-grid {
      display: grid;
      gap: 14px;
    }
    .two-col {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .three-col {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
      font-weight: 700;
    }
    .field-note {
      font-size: 12px;
      color: #8a7d72;
      margin-top: -2px;
    }
    input, select, button {
      font: inherit;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 16px;
      min-height: 54px;
      height: 54px;
      padding: 15px 16px;
      background: #fff;
      color: var(--text);
      transition: border-color 140ms ease, box-shadow 140ms ease;
      -webkit-appearance: none;
      appearance: none;
    }
    input:focus, select:focus {
      outline: none;
      border-color: rgba(201, 35, 18, 0.48);
      box-shadow: 0 0 0 4px rgba(201, 35, 18, 0.10);
    }
    input[type="password"] {
      border-color: var(--line) !important;
      box-shadow: none !important;
      outline: none !important;
      background-color: #fff !important;
      background-image: none !important;
    }
    input[type="password"]:focus {
      border-color: rgba(201, 35, 18, 0.48) !important;
      box-shadow: 0 0 0 4px rgba(201, 35, 18, 0.10) !important;
    }
    input:-webkit-autofill,
    input:-webkit-autofill:hover,
    input:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--text);
      -webkit-box-shadow: 0 0 0px 1000px #fff inset !important;
      transition: background-color 9999s ease-out 0s;
    }
    .option-boxes {
      display: grid;
      gap: 12px;
    }
    .check-item {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 12px;
      align-items: start;
      padding: 14px 16px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: #fff;
      color: var(--text);
      font-weight: 600;
    }
    .check-item input {
      width: 18px;
      height: 18px;
      margin-top: 2px;
      min-height: 18px;
      padding: 0;
      border-radius: 4px;
      border: 1px solid #cdbda9;
      background: #fff;
      appearance: auto;
      -webkit-appearance: checkbox;
      accent-color: var(--accent);
      box-shadow: none;
    }
    .actions {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 14px 20px;
      font-weight: 800;
      cursor: pointer;
      transition: transform 140ms ease, opacity 140ms ease;
    }
    button:hover {
      transform: translateY(-1px);
    }
    .primary {
      background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: #fff;
      box-shadow: 0 12px 24px rgba(150, 23, 7, 0.18);
    }
    .secondary {
      background: #fff;
      color: var(--text);
      border: 1px solid var(--line);
    }
    .sidebar {
      display: grid;
      gap: 18px;
      position: sticky;
      top: 20px;
    }
    .summary-grid {
      display: grid;
      gap: 10px;
    }
    .summary-item {
      padding: 14px 15px;
      border-radius: 18px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
    }
    .summary-label {
      color: var(--muted);
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .summary-value {
      margin: 0;
      font-size: 16px;
      font-weight: 800;
      line-height: 1.35;
    }
    .preview-list {
      display: grid;
      gap: 10px;
    }
    .ticket-holder-list {
      display: grid;
      gap: 12px;
    }
    .ticket-holder-card {
      display: grid;
      gap: 10px;
      padding: 14px;
      border-radius: 18px;
      border: 1px solid var(--line);
      background: #fff;
    }
    .ticket-holder-title {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .preview-row {
      display: grid;
      gap: 4px;
      padding: 12px 14px;
      border-radius: 16px;
      background: var(--panel-soft);
      border: 1px solid var(--line);
    }
    .preview-key {
      color: var(--muted);
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .preview-value {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.45;
      color: var(--text);
      word-break: break-word;
    }
    .status {
      display: grid;
      gap: 12px;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      width: fit-content;
      border-radius: 999px;
      padding: 8px 14px;
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      background: #efe7db;
      color: #5e544c;
    }
    .status-badge.running {
      background: #fff0d9;
      color: var(--warning);
    }
    .status-badge.waiting {
      background: #fff4d6;
      color: var(--warning);
    }
    .status-badge.done {
      background: #e3f5e8;
      color: var(--success);
    }
    .status-badge.error {
      background: #ffe1de;
      color: var(--danger);
    }
    .status-log {
      margin: 0;
      line-height: 1.6;
      font-size: 15px;
    }
    .hint {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.55;
    }
    .rounds {
      display: grid;
      gap: 12px;
    }
    .round-picker {
      display: grid;
      gap: 8px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 22px;
      background: var(--panel-soft);
    }
    .round-select-label {
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .round-list {
      border-radius: 22px;
      overflow: hidden;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      box-shadow: var(--shadow);
    }
    .round-head, .round-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: center;
    }
    .round-head {
      padding: 14px 18px;
      background: var(--panel-soft);
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      border-bottom: 1px solid var(--line);
    }
    .round-row {
      width: 100%;
      border: 0;
      border-top: 1px solid var(--line);
      border-radius: 0;
      background: var(--panel);
      color: var(--text);
      padding: 18px;
      text-align: left;
      box-shadow: none;
    }
    .round-row:hover {
      transform: none;
      background: #fff8f1;
    }
    .round-row.active {
      background: #fff4ec;
    }
    .round-date {
      font-size: 17px;
      font-weight: 800;
    }
    .round-venue {
      color: var(--muted);
      font-size: 13px;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .round-price {
      color: #8b7b6f;
      font-size: 12px;
      margin-top: 4px;
    }
    .round-meta {
      display: grid;
      justify-items: end;
      gap: 8px;
    }
    .round-time {
      min-width: 126px;
      text-align: center;
      border-radius: 999px;
      padding: 10px 16px;
      background: linear-gradient(180deg, var(--accent) 0%, var(--accent-dark) 100%);
      color: #fff;
      font-size: 19px;
      font-weight: 900;
    }
    .round-sale-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 88px;
      padding: 5px 11px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 900;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .round-sale-badge.open {
      background: rgba(74, 222, 128, 0.18);
      color: #88f2ad;
      border: 1px solid rgba(74, 222, 128, 0.28);
    }
    .round-sale-badge.closed {
      background: #f0ebe4;
      color: #7f7164;
      border: 1px solid #ddd1c3;
    }
    @media (max-width: 980px) {
      .layout {
        grid-template-columns: 1fr;
      }
      .sidebar {
        position: static;
      }
    }
    @media (max-width: 720px) {
      .wrap {
        padding: 24px 14px 48px;
      }
      .two-col, .three-col {
        grid-template-columns: 1fr;
      }
      .round-head, .round-row {
        grid-template-columns: 1fr;
      }
      .round-time {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header class="page-head">
      <span class="eyebrow">Ticket Bot Control</span>
      <h1 class="page-title">ตั้งค่างานกดบัตรในหน้าเดียว</h1>
      <p class="page-copy">แยกข้อมูลลูกค้า, ข้อมูลงาน, และเงื่อนไข auto เลือกที่นั่งให้ชัดขึ้น เพื่อให้เริ่มงานง่ายและอ่านสถานะระหว่าง flow ได้เร็วกว่าเดิม</p>
    </header>
    <section class="layout">
      <section class="main-column">
        <section class="panel">
          <div class="section-head">
            <h2 class="section-title">ข้อมูลงานที่ต้องการกดบัตร</h2>
            <p class="section-copy">ใส่ลิงก์ concert หรือ performance แล้วโหลดรอบจากหน้า event เพื่อเลือกรอบที่ต้องการ</p>
          </div>
          <div class="form-grid">
            <label>
              Concert / Event URL
              <input id="eventUrl" type="url" placeholder="https://www.thaiticketmajor.com/performance/..." />
            </label>
            <label>
              ช่วงเวลา / รอบการแสดง
              <input id="roundText" type="text" placeholder="เช่น วันพุธที่ 13 พฤษภาคม 2569 19:30" />
            </label>
            <div class="actions">
              <button id="loadRounds" class="secondary" type="button">โหลดช่วงเวลาจากหน้า Event</button>
              <button id="startJob" class="primary" type="button" disabled>เริ่มทำงาน</button>
            </div>
            <div id="rounds" class="rounds"></div>
            <p class="hint">ถ้าโหลดรอบไม่สำเร็จ ยังสามารถพิมพ์ข้อความรอบเองแล้วเริ่มงานได้เมื่อรอบนั้นเปิดขาย</p>
          </div>
        </section>

        <section class="panel soft">
          <div class="section-head">
            <h2 class="section-title">ข้อมูลลูกค้า</h2>
            <p class="section-copy">ถ้าใส่ข้อมูล login หรือ verify มา ระบบจะช่วยกรอกให้เองในขั้นที่รองรับ ถ้าเว้นว่าง ลูกค้าจะต้องทำด้วยมือ</p>
          </div>
          <div class="form-grid">
            <div class="two-col">
              <label>
                Username / Email
                <input id="loginUsername" type="email" placeholder="อีเมลสำหรับเข้าสู่ระบบ" />
              </label>
              <label>
                Password
                <input id="loginPassword" type="password" placeholder="รหัสผ่าน" />
              </label>
            </div>
            <div class="three-col">
              <label>
                Verify method
                <select id="verifyMethod">
                  <option value="">เลือกประเภทการยืนยัน</option>
                  <option value="thaiid">Thai ID</option>
                  <option value="passport">Passport</option>
                </select>
              </label>
              <label>
                Thai ID
                <input id="thaiId" type="text" inputmode="numeric" maxlength="13" placeholder="13 หลัก" />
              </label>
              <label>
                Passport No.
                <input id="passportNumber" type="text" placeholder="Passport number" />
              </label>
            </div>
            <label>
              Passport Country
              <input id="passportCountry" type="text" placeholder="เช่น TH, JP, US" />
            </label>
          </div>
        </section>

        <section class="panel">
          <div class="section-head">
            <h2 class="section-title">ข้อมูลสำหรับ Auto เลือก Zone / ที่นั่ง</h2>
            <p class="section-copy">กำหนดจำนวนบัตร, โซนที่อยากลองก่อน, ที่นั่งที่ต้องการ และ fallback rule ตอนที่นั่งเต็ม</p>
          </div>
          <div class="form-grid">
            <div class="three-col">
              <label>
                จำนวนบัตร
                <input id="ticketQuantity" type="number" min="1" max="4" value="1" />
              </label>
              <label>
                Preferred zones
                <input id="zonePreference" type="text" placeholder="เช่น A2, A3, B2" />
              </label>
              <label>
                Preferred seats
                <input id="preferredSeats" type="text" placeholder="เช่น G-49, G-50" />
              </label>
            </div>
            <label>
              ลำดับการเลือกที่นั่งเมื่อไม่ได้ระบุเลขที่นั่ง
              <select id="seatSelectionStrategy">
                <option value="default">ใช้ลำดับเดิมของระบบ</option>
                <option value="closest-stage">ใกล้เวทีที่สุด</option>
                <option value="center-most">กลางสุด</option>
                <option value="front-left">ข้างหน้าซ้ายไปขวา</option>
                <option value="front-right">ข้างหน้าขวาไปซ้าย</option>
                <option value="back-left">ข้างหลังซ้ายไปขวา</option>
                <option value="back-right">ข้างหลังขวาไปซ้าย</option>
              </select>
            </label>
            <div>
              <div class="section-copy" style="margin-bottom:12px;">ชื่อบนบัตรจะสร้างตามจำนวนบัตร และใช้กรอกในหน้า register อัตโนมัติถ้ากรอกมาครบ</div>
              <div id="ticketHolderFields" class="ticket-holder-list"></div>
            </div>
            <div class="option-boxes">
              <label class="check-item">
                <input id="requireAdjacent" type="checkbox" />
                <span>ถ้าเลือกมากกว่า 1 ที่นั่ง ต้องติดกัน</span>
              </label>
              <label class="check-item">
                <input id="allowFallbackAny" type="checkbox" />
                <span>ถ้าเต็ม ให้ระบบเลือกโซนไหนก็ได้ ที่นั่งไหนก็ได้</span>
              </label>
            </div>
          </div>
        </section>
      </section>

      <aside class="sidebar">
        <section class="panel">
          <div class="section-head">
            <h2 class="section-title">สถานะการทำงาน</h2>
            <p class="section-copy">ติดตามได้ว่าตอนนี้ระบบกำลังรอ login, verify, queue หรือเข้าสู่ขั้นเลือกที่นั่งแล้ว</p>
          </div>
          <div class="status">
            <div id="statusBadge" class="status-badge idle">พร้อม</div>
            <p id="statusText" class="status-log">พร้อมเริ่มงาน</p>
          </div>
        </section>

        <section class="panel soft">
          <div class="section-head">
            <h2 class="section-title">Preview ก่อนเริ่ม</h2>
            <p class="section-copy">สรุป config ที่ระบบจะใช้กับรอบนี้ก่อนกดเริ่มทำงาน</p>
          </div>
          <div id="configPreview" class="preview-list"></div>
        </section>

        <section class="panel soft">
          <div class="section-head">
            <h2 class="section-title">สรุปสั้น ๆ</h2>
            <p class="section-copy">แนวทางใช้งานของหน้าควบคุมนี้</p>
          </div>
          <div class="summary-grid">
            <div class="summary-item">
              <div class="summary-label">Link Concert</div>
              <p class="summary-value">ใส่ URL งานที่ต้องการกดบัตรก่อนทุกครั้ง</p>
            </div>
            <div class="summary-item">
              <div class="summary-label">ช่วงเวลา</div>
              <p class="summary-value">โหลดรอบจากหน้า event แล้วเลือกแถวที่เปิดขาย</p>
            </div>
            <div class="summary-item">
              <div class="summary-label">ข้อมูลลูกค้า</div>
              <p class="summary-value">login และ verify ใส่เฉพาะเมื่ออยากให้ระบบช่วยกรอก</p>
            </div>
            <div class="summary-item">
              <div class="summary-label">Auto Seat</div>
              <p class="summary-value">ระบบจะใช้ zone / seat ตามลำดับที่ระบุและ fallback ตาม checkbox</p>
            </div>
          </div>
        </section>
      </aside>
    </section>
  </main>
  <script>
    const eventUrl = document.getElementById("eventUrl");
    const roundText = document.getElementById("roundText");
    const rounds = document.getElementById("rounds");
    const statusBadge = document.getElementById("statusBadge");
    const statusText = document.getElementById("statusText");
    const startJobButton = document.getElementById("startJob");
    const configPreview = document.getElementById("configPreview");
    const ticketHolderFields = document.getElementById("ticketHolderFields");
    const loginUsername = document.getElementById("loginUsername");
    const loginPassword = document.getElementById("loginPassword");
    const ticketQuantity = document.getElementById("ticketQuantity");
    const zonePreference = document.getElementById("zonePreference");
    const preferredSeats = document.getElementById("preferredSeats");
    const seatSelectionStrategy = document.getElementById("seatSelectionStrategy");
    const verifyMethod = document.getElementById("verifyMethod");
    const thaiId = document.getElementById("thaiId");
    const passportNumber = document.getElementById("passportNumber");
    const passportCountry = document.getElementById("passportCountry");
    const requireAdjacent = document.getElementById("requireAdjacent");
    const allowFallbackAny = document.getElementById("allowFallbackAny");
    const sampleUrl = "https://www.thaiticketmajor.com/performance/when-oranges-fall-first-fall-first-love.html";
    eventUrl.value = sampleUrl;
    let saleOpen = false;
    let selectedRoundValue = "";
    let roundOptionsCache = [];

    function getTicketHolderInputs() {
      return Array.from(document.querySelectorAll(".ticket-holder-name"));
    }

    function getTicketHolderNames() {
      return getTicketHolderInputs()
        .map((input) => input.value.trim())
        .filter(Boolean);
    }

    function renderTicketHolderFields() {
      const count = Math.min(4, Math.max(1, Number(ticketQuantity.value) || 1));
      if (Number(ticketQuantity.value) !== count) {
        ticketQuantity.value = String(count);
      }
      const previousValues = getTicketHolderInputs().map((input) => input.value);
      ticketHolderFields.innerHTML = "";

      for (let index = 0; index < count; index += 1) {
        const wrapper = document.createElement("div");
        wrapper.className = "ticket-holder-card";
        wrapper.innerHTML =
          '<p class="ticket-holder-title">ชื่อบนบัตรใบที่ ' + (index + 1) + '</p>' +
          '<label>' +
            'ชื่อ-นามสกุลบน Ticket' +
            '<input class="ticket-holder-name" type="text" placeholder="เช่น สมชาย ใจดี" value="' +
            (previousValues[index] || "") +
            '" />' +
          '</label>';
        ticketHolderFields.appendChild(wrapper);
      }

      getTicketHolderInputs().forEach((input) => {
        input.addEventListener("input", renderPreview);
      });
    }

    function renderPreview() {
      const verifySummary = verifyMethod.value === "thaiid"
        ? (thaiId.value.trim() ? "Thai ID พร้อมกรอกอัตโนมัติ" : "Thai ID แต่ยังไม่ได้กรอกเลข")
        : verifyMethod.value === "passport"
          ? (
            passportNumber.value.trim() && passportCountry.value.trim()
              ? "Passport พร้อมกรอกอัตโนมัติ"
              : "Passport แต่ข้อมูลยังไม่ครบ"
          )
          : "ถ้าเว็บถาม verify เพิ่ม ลูกค้าต้องกรอกเอง";
      const items = [
        ["Event URL", eventUrl.value.trim() || "-"],
        ["รอบที่เลือก", roundText.value.trim() || "-"],
        ["ชื่อบนบัตร", getTicketHolderNames().length
          ? getTicketHolderNames().join(" | ")
          : "ถ้าหน้างานบังคับกรอกชื่อ ลูกค้าต้องกรอกเอง"],
        ["การ login", loginUsername.value.trim() ? "Auto login ด้วย " + loginUsername.value.trim() : "ให้ลูกค้า login เอง"],
        ["จำนวนบัตร", ticketQuantity.value || "1"],
        ["Preferred zones", zonePreference.value.trim() || "ให้ระบบเลือกตามที่หาได้"],
        ["Preferred seats", preferredSeats.value.trim() || "ไม่ได้ล็อกที่นั่งเฉพาะ"],
        ["ลำดับเลือกที่นั่ง", preferredSeats.value.trim()
          ? "ข้าม เพราะระบุเลขที่นั่งไว้แล้ว"
          : ({
              "default": "ใช้ลำดับเดิมของระบบ",
              "closest-stage": "ใกล้เวทีที่สุด",
              "center-most": "กลางสุด",
              "front-left": "ข้างหน้าซ้ายไปขวา",
              "front-right": "ข้างหน้าขวาไปซ้าย",
              "back-left": "ข้างหลังซ้ายไปขวา",
              "back-right": "ข้างหลังขวาไปซ้าย"
            }[seatSelectionStrategy.value] || "ใช้ลำดับเดิมของระบบ")],
        ["ที่นั่งติดกัน", requireAdjacent.checked ? "ต้องติดกัน" : "ไม่บังคับติดกัน"],
        ["Fallback", allowFallbackAny.checked ? "ยอมเปลี่ยนโซน/ที่นั่งได้" : "ยึดตาม preference ก่อน"],
        ["Verify", verifySummary],
      ];

      configPreview.innerHTML = items
        .map(
          ([key, value]) =>
            '<div class="preview-row"><div class="preview-key">' +
            key +
            '</div><p class="preview-value">' +
            value +
            "</p></div>",
        )
        .join("");
    }

    function updateStartButton() {
      if (Number(ticketQuantity.value) > 4) {
        ticketQuantity.value = "4";
      }

      const isLocked = statusBadge.classList.contains("running");
      const canStart =
        !isLocked &&
        Boolean(roundText.value.trim()) &&
        Number(ticketQuantity.value) > 0;
      startJobButton.disabled = !canStart;
      startJobButton.style.opacity = canStart ? "1" : "0.5";
      startJobButton.style.cursor = canStart ? "pointer" : "not-allowed";
      renderPreview();
    }

    function selectRoundItem(index) {
      const item = roundOptionsCache[index];
      if (!item) {
        return;
      }

      roundText.value = item.label;
      selectedRoundValue = item.roundValue || "";
      saleOpen = Boolean(item.isOpen);

      statusText.textContent = item.isOpen
        ? "เลือกรอบแล้ว พร้อมเริ่มงานได้ทันที"
        : "เลือกรอบแล้ว ระบบจะรอที่หน้า event จนกว่ารอบนี้จะเปิดขาย";
      updateStartButton();
    }

    function badgeMeta(status) {
      const message = String(status.message || "").toLowerCase();
      if (status.state === "error") {
        return { text: "ผิดพลาด", className: "error" };
      }
      if (status.state === "done") {
        return { text: "เสร็จแล้ว", className: "done" };
      }
      if (message.includes("waiting for customer to log in manually")) {
        return { text: "รอ Login", className: "waiting" };
      }
      if (message.includes("correct login manually")) {
        return { text: "รอ Login", className: "waiting" };
      }
      if (message.includes("waiting for customer to complete manually")) {
        return { text: "รอ Verify", className: "waiting" };
      }
      if (message.includes("anti-bot verification is required")) {
        return { text: "รอ Captcha", className: "waiting" };
      }
      if (message.includes("selected performance round")) {
        return { text: "เลือกรอบ", className: "running" };
      }
      if (message.includes("quantity selection")) {
        return { text: "เลือกจำนวน", className: "running" };
      }
      if (message.includes("identity verification")) {
        return { text: "ยืนยันตัวตน", className: "running" };
      }
      if (message.includes("seat flow attempt") || message.includes("selected seat candidate")) {
        return { text: "เลือกที่นั่ง", className: "running" };
      }
      if (message.includes("opened zone availability popup")) {
        return { text: "เข้าโซน", className: "running" };
      }
      if (message.includes("still in queue")) {
        return { text: "รอคิว", className: "waiting" };
      }
      if (status.state === "running") {
        return { text: "กำลังทำงาน", className: "running" };
      }
      return { text: "พร้อม", className: "idle" };
    }

    async function refreshStatus() {
      const response = await fetch("/api/status");
      const status = await response.json();
      const badge = badgeMeta(status);
      statusBadge.textContent = badge.text;
      statusBadge.className = "status-badge " + badge.className;
      statusText.textContent = status.message;
      if (status.state === "running") {
        startJobButton.disabled = true;
        startJobButton.style.opacity = "0.5";
        startJobButton.style.cursor = "not-allowed";
      } else {
        updateStartButton();
      }
    }

    function renderRoundOptions(items) {
      rounds.innerHTML = "";
      if (!items.length) {
        roundOptionsCache = [];
        return;
      }

      roundOptionsCache = items.slice();
      const wrapper = document.createElement("div");
      wrapper.className = "round-picker";
      wrapper.innerHTML =
        '<label class="round-select-label">เลือกรอบที่ต้องการ<select id="roundSelectPicker"></select></label>';
      rounds.appendChild(wrapper);

      const select = wrapper.querySelector("#roundSelectPicker");
      select.innerHTML = items
        .map((item, index) => {
          const saleTag = item.isOpen ? "เปิดขาย" : "ยังไม่เปิด/ปิดขาย";
          const venuePart = item.venueText ? item.venueText + " • " : "";
          return '<option value="' + index + '">' + venuePart + item.label + " • " + saleTag + "</option>";
        })
        .join("");

      select.addEventListener("change", (event) => {
        selectRoundItem(Number(event.target.value || 0));
      });

      selectRoundItem(0);
    }

    async function loadRoundHints() {
      rounds.innerHTML = "";
      saleOpen = false;
      updateStartButton();
      statusText.textContent = "กำลังโหลดเวลารอบจากหน้า event...";
      const response = await fetch("/api/rounds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventUrl: eventUrl.value.trim() })
      });
      const result = await response.json();
      if (!response.ok) {
        statusText.textContent = result.error || "โหลดเวลารอบไม่สำเร็จ";
        return;
      }
      if (!result.rounds.length) {
        statusText.textContent = "ไม่พบเวลารอบจากหน้า event ให้กรอกเองได้";
        return;
      }
      saleOpen = Boolean(result.saleOpen);
      statusText.textContent = result.notice || (saleOpen
        ? "กดเลือกเวลาที่ต้องการได้เลย"
        : "พบรอบการแสดง แต่ยังไม่เปิดให้กดบัตร");
      renderRoundOptions(result.rounds);
      updateStartButton();
    }

    async function startJob() {
      if (!roundText.value.trim()) {
        statusText.textContent = "กรุณาเลือกรอบก่อนเริ่มงาน";
        return;
      }
      if (Number(ticketQuantity.value) > 1 && requireAdjacent.checked && !allowFallbackAny.checked) {
        statusText.textContent = "ระบบจะ retry หาแบบติดกันให้อัตโนมัติ 5 รอบถ้าเต็ม";
      }
      statusText.textContent = "กำลังเริ่มงาน...";
      const response = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventUrl: eventUrl.value.trim(),
          roundText: roundText.value.trim(),
          roundValue: selectedRoundValue,
          attendeeNames: getTicketHolderNames(),
          loginUsername: loginUsername.value.trim(),
          loginPassword: loginPassword.value,
          ticketQuantity: ticketQuantity.value,
          zonePreference: zonePreference.value,
          preferredSeats: preferredSeats.value,
          seatSelectionStrategy: seatSelectionStrategy.value,
          verifyMethod: verifyMethod.value,
          thaiId: thaiId.value,
          passportNumber: passportNumber.value,
          passportCountry: passportCountry.value,
          requireAdjacent: requireAdjacent.checked,
          allowFallbackAny: allowFallbackAny.checked
        })
      });
      const result = await response.json();
      statusBadge.textContent = response.ok ? "กำลังทำงาน" : "ผิดพลาด";
      statusBadge.className = "status-badge " + (response.ok ? "running" : "error");
      statusText.textContent = result.message || result.error || "เริ่มงานไม่สำเร็จ";
    }

    document.getElementById("loadRounds").addEventListener("click", loadRoundHints);
    document.getElementById("startJob").addEventListener("click", startJob);
    roundText.addEventListener("input", updateStartButton);
    ticketQuantity.addEventListener("input", () => {
      renderTicketHolderFields();
      updateStartButton();
    });
    loginUsername.addEventListener("input", renderPreview);
    loginPassword.addEventListener("input", renderPreview);
    zonePreference.addEventListener("input", renderPreview);
    seatSelectionStrategy.addEventListener("change", renderPreview);
    verifyMethod.addEventListener("change", renderPreview);
    thaiId.addEventListener("input", renderPreview);
    passportNumber.addEventListener("input", renderPreview);
    passportCountry.addEventListener("input", renderPreview);
    requireAdjacent.addEventListener("change", renderPreview);
    allowFallbackAny.addEventListener("change", renderPreview);
    preferredSeats.addEventListener("input", () => {
      const count = preferredSeats.value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean).length;
      if (count > 0) {
        ticketQuantity.value = String(count);
      }
      updateStartButton();
    });
    eventUrl.addEventListener("input", () => {
      saleOpen = false;
      selectedRoundValue = "";
      updateStartButton();
    });
    renderTicketHolderFields();
    updateStartButton();
    renderPreview();
    refreshStatus();
    setInterval(refreshStatus, 2000);
  </script>
</body>
</html>`;

let runState: RunState = {
  state: "idle",
  message: "พร้อมเริ่มงาน",
};

function json(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function normalizeRunConfig(body: Record<string, unknown>): BotRunConfig {
  const eventUrl =
    typeof body.eventUrl === "string" && body.eventUrl.trim()
      ? body.eventUrl.trim()
      : concertConfig.eventUrl;
  const roundText =
    typeof body.roundText === "string" && body.roundText.trim()
      ? body.roundText.trim()
      : undefined;
  const roundValue =
    typeof body.roundValue === "string" && body.roundValue.trim()
      ? body.roundValue.trim()
      : undefined;
  const attendeeNames = Array.isArray(body.attendeeNames)
    ? body.attendeeNames
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  const loginUsername =
    typeof body.loginUsername === "string" && body.loginUsername.trim()
      ? body.loginUsername.trim()
      : undefined;
  const loginPassword =
    typeof body.loginPassword === "string" && body.loginPassword
      ? body.loginPassword
      : undefined;
  const zonePreference =
    typeof body.zonePreference === "string" && body.zonePreference.trim()
      ? body.zonePreference
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
  const preferredSeats =
    typeof body.preferredSeats === "string" && body.preferredSeats.trim()
      ? body.preferredSeats
          .split(",")
          .map((item) => item.trim().toUpperCase())
          .filter(Boolean)
      : [];
  const rawSeatSelectionStrategy =
    typeof body.seatSelectionStrategy === "string"
      ? body.seatSelectionStrategy.trim().toLowerCase()
      : "";
  const seatSelectionStrategy: SeatSelectionStrategy =
    rawSeatSelectionStrategy === "closest-stage" ||
    rawSeatSelectionStrategy === "center-most" ||
    rawSeatSelectionStrategy === "front-left" ||
    rawSeatSelectionStrategy === "front-right" ||
    rawSeatSelectionStrategy === "back-left" ||
    rawSeatSelectionStrategy === "back-right"
      ? rawSeatSelectionStrategy
      : rawSeatSelectionStrategy === "best"
        ? "closest-stage"
      : "default";
  const ticketQuantity =
    typeof body.ticketQuantity === "number"
      ? Math.min(4, Math.max(1, Math.floor(body.ticketQuantity)))
      : typeof body.ticketQuantity === "string" && body.ticketQuantity.trim()
        ? Math.min(4, Math.max(1, Number.parseInt(body.ticketQuantity, 10) || 1))
        : Math.min(4, Math.max(1, preferredSeats.length || concertConfig.maxTickets));
  const requireAdjacent = Boolean(body.requireAdjacent);
  const allowFallbackAny = Boolean(body.allowFallbackAny);
  const rawVerifyMethod =
    typeof body.verifyMethod === "string" ? body.verifyMethod.trim().toLowerCase() : "";
  const verifyMethod =
    rawVerifyMethod === "thaiid" || rawVerifyMethod === "passport"
      ? rawVerifyMethod
      : undefined;
  const thaiId =
    typeof body.thaiId === "string" && body.thaiId.trim()
      ? body.thaiId.replace(/\D+/g, "")
      : undefined;
  const passportNumber =
    typeof body.passportNumber === "string" && body.passportNumber.trim()
      ? body.passportNumber.trim().toUpperCase()
      : undefined;
  const passportCountry =
    typeof body.passportCountry === "string" && body.passportCountry.trim()
      ? body.passportCountry.trim().toUpperCase()
      : undefined;

  return {
    eventUrl,
    roundText,
    roundValue,
    attendeeNames,
    loginUsername,
    loginPassword,
    zonePreference,
    preferredSeats,
    seatSelectionStrategy,
    ticketQuantity,
    requireAdjacent,
    allowFallbackAny,
    verifyMethod,
    thaiId,
    passportNumber,
    passportCountry,
  };
}

function decodeHtml(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function rowLooksOpen(rowHtml: string): boolean {
  const disabled = /disabled(?:\s*=\s*["']?["']?)?/i.test(rowHtml);
  if (disabled) {
    return false;
  }

  return (
    /class="btn"/i.test(rowHtml) &&
    (/onclick=.*zones\.php/i.test(rowHtml) ||
      /onclick=.*popup\.signin/i.test(rowHtml) ||
      /item-hide[^>]*>\s*ซื้อบัตร/i.test(rowHtml) ||
      /item-hide[^>]*>\s*buy/i.test(rowHtml))
  );
}

function isSaleInfoLabel(text: string): boolean {
  return /วันเปิดจำหน่าย|public sale|pre[-\s]?sale|on sale/i.test(text);
}

function normalizeDateLabel(text: string): string {
  return text
    .replace(/^\s*วันที่แสดง\s*/i, "")
    .replace(/^\s*วันเปิดจำหน่าย\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractColLabelText(rowHtml: string): string {
  const colLabelMatch = rowHtml.match(
    /<div[^>]*class="[^"]*col-label[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class="[^"]*col-btn[^"]*"/i,
  );
  if (!colLabelMatch) {
    return "";
  }

  return normalizeDateLabel(decodeHtml(colLabelMatch[1]));
}

function extractVenueText(itemHtml: string): string {
  return decodeHtml(itemHtml.match(/<a[^>]*class="[^"]*venue[^"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "");
}

function extractPriceText(itemHtml: string): string {
  return decodeHtml(
    itemHtml.match(/ราคาบัตร<\/small><br[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "",
  );
}

function extractRoundValue(rowHtml: string): string | undefined {
  const bookingUrl =
    rowHtml.match(/popup\.signin\('([^']+booking[^']+)'\)/i)?.[1] ??
    rowHtml.match(/onclick="[^"]*(https?:\/\/[^"]+booking[^"]+)"/i)?.[1] ??
    rowHtml.match(/href="([^"]*(?:zones|queue|booking)\.php[^"]*)"/i)?.[1];
  if (bookingUrl) {
    return bookingUrl.trim();
  }

  const dataButton = rowHtml.match(/data-button="([^"]+)"/i)?.[1];
  if (dataButton) {
    return dataButton.trim();
  }

  return undefined;
}

function extractRoundHints(html: string): RoundOption[] {
  const eventItemPattern =
    /<div[^>]*class="[^"]*event-detail-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]*class="[^"]*event-detail-item[^"]*"|<!--\s*\/ EVENT ROUND|<\/div>\s*<\/section>)/gi;
  const eventRowPattern =
    /(<div[^>]*class="[^"]*row[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*col-label[^"]*"[^>]*>[\s\S]*?<div[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div[^>]*class="[^"]*col-btn[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*item-show[^"]*"[^>]*>([\s\S]*?)<\/span>[\s\S]*?<\/div>[\s\S]*?<\/div>)/gi;
  const rowPattern =
    /(<div[^>]*class="[^"]*date[^"]*"[^>]*>([\s\S]*?)<\/div>[\s\S]*?<div[^>]*class="[^"]*time[^"]*"[^>]*>([\s\S]*?)<\/div>)/gi;
  const rounds: RoundOption[] = [];
  const seen = new Set<string>();

  for (const itemMatch of html.matchAll(eventItemPattern)) {
    const itemHtml = itemMatch[1];
    const venueText = extractVenueText(itemHtml);
    const priceText = extractPriceText(itemHtml);

    for (const rowMatch of itemHtml.matchAll(eventRowPattern)) {
      const rowHtml = rowMatch[1];
      const dateText = extractColLabelText(rowHtml) || decodeHtml(rowMatch[2]);
      const timeText = decodeHtml(rowMatch[3]).match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
      if (!dateText || !timeText || isSaleInfoLabel(dateText)) {
        continue;
      }

      const label = `${dateText} ${timeText}`.trim();
      const roundValue = extractRoundValue(rowHtml);
      const dedupeKey = `${venueText}__${label}__${roundValue ?? ""}`;
      if (seen.has(dedupeKey)) {
        continue;
      }
      seen.add(dedupeKey);
      rounds.push({
        venueText,
        priceText,
        dateText,
        timeText,
        label,
        isOpen: rowLooksOpen(rowHtml),
        roundValue,
      });
    }
  }

  if (!rounds.length) {
    for (const match of html.matchAll(rowPattern)) {
      const dateText = normalizeDateLabel(decodeHtml(match[2]));
      const timeText = decodeHtml(match[3]).match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0];
      if (!dateText || !timeText || isSaleInfoLabel(dateText)) {
        continue;
      }

      const label = `${dateText} ${timeText}`.trim();
      if (seen.has(label)) {
        continue;
      }
      seen.add(label);
      rounds.push({ dateText, timeText, label, isOpen: /buy|ซื้อบัตร/i.test(match[1]) });
    }
  }

  if (rounds.length) {
    return rounds;
  }

  const linePattern =
    /(วัน[^<\n\r]{4,120}?)\s*(?:<\/[^>]+>\s*){0,3}.*?\b((?:[01]?\d|2[0-3]):[0-5]\d)\b/gi;
  for (const match of html.matchAll(linePattern)) {
    const dateText = normalizeDateLabel(decodeHtml(match[1]));
    const timeText = match[2];
    const label = `${dateText} ${timeText}`.trim();
    if (!dateText || isSaleInfoLabel(dateText) || seen.has(label)) {
      continue;
    }
    seen.add(label);
    rounds.push({ dateText, timeText, label, isOpen: false });
  }

  return rounds;
}

async function fetchRoundHints(eventUrl: string): Promise<RoundHintsResponse> {
  const response = await fetch(eventUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch event page: ${response.status}`);
  }
  const html = await response.text();
  const rounds = extractRoundHints(html);
  const saleOpen = rounds.some((round) => round.isOpen);
  const notice = rounds.length
    ? saleOpen
      ? "กดเลือกเวลาที่ต้องการได้เลย"
      : "มีช่วงเวลาแสดงตามรายการด้านล่าง แต่ยังไม่เปิดให้กดบัตร"
    : "ไม่พบเวลารอบจากหน้า event ให้กรอกเองได้";
  return { rounds, saleOpen, notice };
}

function startBotRun(config: BotRunConfig) {
  if (runState.state === "running") {
    throw new Error("แอปรองรับการรันบอททีละ 1 งานเท่านั้น กรุณารอให้งานปัจจุบันจบก่อน");
  }

  runState = {
    state: "running",
    message: `เริ่มทำงานกับ ${config.eventUrl}${config.roundText ? ` / รอบ ${config.roundText}` : ""}`,
    config,
  };

  void (async () => {
    const bot = new TicketAssistBot(config, (message) => {
      runState = {
        state: "running",
        message,
        config,
      };
    });

    try {
      await bot.init();
      await bot.run();
      runState = {
        state: "done",
        message: concertConfig.stopBeforePayment
          ? "งานจบรอบนี้แล้ว บอทหยุดก่อน payment ตาม config และคง browser ไว้ให้ชำระเงินต่อเอง"
          : "งานจบรอบนี้แล้ว",
        config,
      };
    } catch (error) {
      runState = {
        state: "error",
        message:
          error instanceof Error ? error.message : "เกิดข้อผิดพลาดระหว่างรัน bot",
        config,
      };
    } finally {
      await bot.close();
    }
  })();
}

async function route(req: IncomingMessage, res: ServerResponse) {
  if (!req.url) {
    json(res, 404, { error: "Not found" });
    return;
  }

  if (req.method === "GET" && req.url === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(uiHtml);
    return;
  }

  if (req.method === "GET" && req.url === "/api/status") {
    json(res, 200, runState);
    return;
  }

  if (req.method === "POST" && req.url === "/api/rounds") {
    try {
      const body = await readJsonBody(req);
      const config = normalizeRunConfig(body);
      const result = await fetchRoundHints(config.eventUrl);
      json(res, 200, result);
    } catch (error) {
      json(res, 400, {
        error: error instanceof Error ? error.message : "โหลดเวลารอบไม่สำเร็จ",
      });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/api/start") {
    try {
      const body = await readJsonBody(req);
      const config = normalizeRunConfig(body);
      startBotRun(config);
      json(res, 200, {
        message: `เริ่มทำงานแล้ว${config.roundText ? ` ที่รอบ ${config.roundText}` : ""}`,
      });
    } catch (error) {
      json(res, 409, {
        error: error instanceof Error ? error.message : "เริ่มงานไม่สำเร็จ",
      });
    }
    return;
  }

  json(res, 404, { error: "Not found" });
}

type ControlServerHandle = {
  server: Server;
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

async function startControlServer(
  requestedPort = Number(process.env.PORT || "3000"),
  host = "127.0.0.1",
): Promise<ControlServerHandle> {
  loadEnvFile();
  const server = createServer((req, res) => {
    void route(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port =
    address && typeof address === "object"
      ? address.port
      : requestedPort;
  const url = `http://${host}:${port}`;

  console.log(`Control page: ${url}`);

  return {
    server,
    host,
    port,
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function main() {
  await startControlServer();
}

if (require.main === module) {
  void main();
}

export { TicketAssistBot, startControlServer, type BotRunConfig, type ControlServerHandle };
