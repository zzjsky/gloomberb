import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useReducer, type ReactElement } from "react";
import { settleFrame, testRender } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState } from "../../../state/app/context";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { apiClient } from "../../../api-client";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { createTestBrokerAdapter } from "../../../test-support/broker";
import { TestPaneProvider, createTestPaneConfig } from "../../../test-support/pane";
import { createTestTicker } from "../../../test-support/ticker";
import type { AppConfig } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import type { BrokerAccount, BrokerPortfolioPerformance } from "../../../types/trading";
import type { PluginRuntimeAccess } from "../../runtime";
import { portfolioAnalyticsModule } from "./index";

const PANE_ID = "analytics:performance";
const PORTFOLIO_ID = "broker:ibkr-live:DU12345";
const AnalyticsPane = portfolioAnalyticsModule.panes![0]!.component as (props: PaneProps) => ReactElement;
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
let coordinator: MarketDataCoordinator | undefined;
const restore: Array<() => void> = [];

function performanceConfig(): AppConfig {
  const config = createTestPaneConfig("/tmp/gloomberb-risk-pane", {
    instanceId: PANE_ID, paneId: "analytics", binding: { kind: "none" },
    params: { portfolioId: PORTFOLIO_ID }, settings: { riskView: "performance" },
  });
  config.portfolios = [{
    id: PORTFOLIO_ID, name: "DU12345", currency: "USD", brokerId: "ibkr", brokerInstanceId: "ibkr-live", brokerAccountId: "DU12345",
  }];
  config.brokerInstances = [
    { id: "ibkr-live", brokerType: "ibkr", label: "IBKR Gateway", connectionMode: "gateway",
      config: { connectionMode: "gateway", gateway: { host: "127.0.0.1" } }, enabled: true },
    { id: "ibkr-flex", brokerType: "ibkr", label: "IBKR Flex", connectionMode: "flex",
      config: { connectionMode: "flex", flex: { token: "token", queryId: "query" } }, enabled: true },
  ];
  return config;
}

function Harness({ config, runtime, accounts }: { config: AppConfig; runtime: PluginRuntimeAccess; accounts: BrokerAccount[] }) {
  const initial = createInitialState(config);
  initial.focusedPaneId = PANE_ID;
  initial.tickers = new Map([["AAPL", createTestTicker("AAPL", "Apple", {
    exchange: "NASDAQ", sector: "Technology", portfolios: [PORTFOLIO_ID],
    positions: [{ portfolio: PORTFOLIO_ID, shares: 10, avgCost: 100, currency: "USD", broker: "ibkr",
      brokerInstanceId: "ibkr-live", brokerAccountId: "DU12345", marketValue: 1250, markPrice: 125 }],
  })]]);
  initial.brokerAccounts = { "ibkr-live": accounts };
  const [state, dispatch] = useReducer(appReducer, initial);
  return <TestPaneProvider state={state} dispatch={dispatch} paneId={PANE_ID} pluginId="portfolio" runtime={runtime}>
    <AnalyticsPane paneId={PANE_ID} paneType="analytics" focused width={100} height={32} />
  </TestPaneProvider>;
}

async function render(runtime: PluginRuntimeAccess, accounts: BrokerAccount[] = []) {
  for (const method of ["getCloudQuotesBatch", "getCloudHistory", "getCloudFredSeries"] as const) {
    const mock = spyOn(apiClient, method).mockImplementation(async () => { throw new Error("offline"); });
    restore.push(() => mock.mockRestore());
  }
  coordinator = new MarketDataCoordinator(createTestDataProvider({
    getQuote: async () => null, getPriceHistory: async () => [], getPriceHistoryForResolution: async () => [],
    getExchangeRate: async () => 0.75,
  }));
  setSharedMarketDataCoordinator(coordinator);
  await act(async () => {
    setup = await testRender(<Harness config={performanceConfig()} runtime={runtime} accounts={accounts} />, { width: 100, height: 32 });
  });
  await settleFrame(setup!, 20);
  return setup!.captureCharFrame();
}

afterEach(async () => {
  if (setup) { await act(async () => setup!.renderer.destroy()); setup = undefined; }
  while (restore.length) restore.pop()!();
  coordinator?.destroy();
  coordinator = undefined;
  setSharedMarketDataCoordinator(null);
});

test("Performance measures the account's daily returns from the configured Flex profile when the Gateway has none", async () => {
  const calls: string[] = [];
  const points: BrokerPortfolioPerformance["points"] = Array.from({ length: 15 }, (_, index) => ({
    date: `2026-09-${String(index + 1).padStart(2, "0")}`,
    cumulativeReturn: index * 0.001,
  }));
  const broker = createTestBrokerAdapter({
    id: "ibkr",
    getPortfolioPerformance: async (instance, accountId) => {
      calls.push(instance.id);
      return instance.id === "ibkr-flex"
        ? { accountId, source: "flex", period: "MTD", currency: "USD", fetchedAt: 1, measure: "TWR", points }
        : null;
    },
  });
  const frame = await render(createTestPluginRuntime({ getBrokerAdapter: () => broker }));
  expect(calls).toEqual(["ibkr-live", "ibkr-flex"]);
  expect(frame).toContain("Account Sharpe");
  expect(frame).toMatch(/TWR\s+1\.40%/);
});

for (const currency of ["CAD", undefined]) test(`account figures convert from the account's own currency (${currency ?? "unknown"})`, async () => {
  const frame = await render(createTestPluginRuntime(), [{
    accountId: "DU12345", name: "DU12345", currency, netLiquidation: 20_000, totalCashValue: 18_000, buyingPower: 40_000,
  }]);
  if (currency) {
    expect(frame).toContain("15.0k");
    expect(frame).toContain("13.5k");
    expect(frame).toContain("30.0k");
  } else {
    expect(frame).not.toContain("20.0k");
    expect(frame).not.toContain("18.0k");
  }
});
