export type ConcertConfig = {
  eventUrl: string;
  maxTickets: number;
  zonePreference: string[];
  seatRowPreference: string[];
  roundValue?: string;
  maxFlowRetries: number;
  retryIntervalMs: number;
  maxRetries: number;
  waitForSaleMs: number;
  stopBeforePayment: boolean;
  headless: boolean;
  debug: boolean;
  storageStatePath: string;
};

export const concertConfig: ConcertConfig = {
  eventUrl:
    "https://www.thaiticketmajor.com/concert/natori-one-man-live-tour-koshin-march-in-bangkok.html",
  maxTickets: 4,
  zonePreference: ["A", "B", "AA", "BB", "CC", "DD", "EE", "FF", "GG"],
  seatRowPreference: ["G", "F", "E", "J", "I", "K", "L", "M", "D", "H"],
  roundValue: "81544",
  maxFlowRetries: 5,
  retryIntervalMs: 300,
  maxRetries: 30,
  waitForSaleMs: 300_000,
  stopBeforePayment: true,
  headless: false,
  debug: false,
  storageStatePath: ".auth/ttm-session.json",
};
