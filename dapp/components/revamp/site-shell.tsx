"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { ccc } from "@ckb-ccc/connector-react";
import { ProtocolData } from "ssri-ckboost/types";
import { usePendingTransactions } from "@/lib/providers/pending-transaction-provider";
import { useDiscovery } from "@/lib/revamp/discovery-provider";
import { useHeaderAccount, type HeaderAccountScope } from "@/lib/revamp/use-header-account";
import { RevampButton, RevampIcon } from "./ui";
import { useRevampTheme } from "./theme";
import { FigmaIcon } from "./figma-icon";
import styles from "./site-shell.module.css";

const BusinessHeader = dynamic(() => import("./business-header"));

export function RevampSiteHeader() {
  const pathname = usePathname();
  return pathname === "/revamp" ? <DiscoveryHeader /> : <BusinessHeader />;
}

function DiscoveryHeader() {
  const discovery = useDiscovery();
  return <RevampHeaderAccount protocolCell={discovery.protocolCell} protocolLoading={discovery.protocolLoading} protocolError={discovery.protocolError?.message} />;
}

export function RevampHeaderAccount(scope: HeaderAccountScope) {
  const { theme, toggleTheme, portalContainer } = useRevampTheme();
  const pathname = usePathname();
  const { open } = ccc.useCcc();
  const account = useHeaderAccount(scope);
  const isPlatformAdmin = useMemo(() => {
    if (!account.isConnected || !account.lockHash || !scope.protocolCell || scope.protocolLoading || scope.protocolError) return false;
    try {
      return ProtocolData.decode(scope.protocolCell.outputData).protocol_config.admin_lock_hash_vec.some(value => ccc.hexFrom(value).toLowerCase() === account.lockHash!.toLowerCase());
    } catch { return false; }
  }, [account.isConnected, account.lockHash, scope.protocolCell, scope.protocolLoading, scope.protocolError]);
  const [walletMenuOpen, setWalletMenuOpen] = useState(false);
  useEffect(() => { setWalletMenuOpen(false); }, [account.address, account.isConnected]);
  const { activeCount } = usePendingTransactions();
  const previousPending = useRef(activeCount);
  useEffect(() => {
    if (previousPending.current > 0 && activeCount === 0) account.refresh();
    previousPending.current = activeCount;
  }, [activeCount, account.refresh]);
  const points = account.points?.toLocaleString("en-US") ?? "—";

  return <header className={styles.header}>
    <Link href="/revamp" prefetch={false} className={styles.brand} aria-label="CKBoost home">
      <span className={styles.wordmark} aria-hidden="true">
        <img src="/assets/revamp/logo-blue.svg" alt="" className={styles.blue} />
        <img src="/assets/revamp/logo-magenta.svg" alt="" className={styles.magenta} />
        <span className={styles.ink} />
      </span>
    </Link>
    <nav className={styles.navigation} aria-label="Main navigation">
      <Link href="/revamp" prefetch={false} aria-current={pathname === "/revamp" || pathname.startsWith("/revamp/campaign") ? "page" : undefined}><span className={styles.navFlag} aria-hidden="true" />Campaigns</Link>
      <Link href="/leaderboard" prefetch={false}><span className={styles.navTrophy}><FigmaIcon name="trophy" size={18} /></span>Leaderboard</Link>
      <Link href="/tipping" prefetch={false}><FigmaIcon name="udt" size={18} />Tipping</Link>
      {isPlatformAdmin && <Link href="/revamp/admin" prefetch={false} aria-current={pathname === "/revamp/admin" || pathname.startsWith("/revamp/admin/") ? "page" : undefined}><span className={styles.navAdmin} aria-hidden="true" />Admin console</Link>}
    </nav>
    <div className={styles.actions}>
      <DropdownMenu.Root open={account.isConnected && walletMenuOpen} onOpenChange={next => { if (account.isConnected) setWalletMenuOpen(next); }}>
      <DropdownMenu.Trigger asChild>
      <RevampButton onClick={() => { if (!account.isConnected) open(); }} variant={account.isConnected ? "secondary" : "primary"} className={`${styles.wallet} ${account.isConnected ? styles.connectedWallet : ""}`}
        aria-label={`${account.isConnected ? `Open wallet${account.address ? ` ${account.address}` : ""}` : 'Connect wallet'}${activeCount ? `, ${activeCount} pending transactions` : ''}`}>
        {account.isConnected && <span className={styles.walletPoints} title={account.error ?? (account.isLoading ? "Loading Points balance" : account.points === null ? "Points balance unavailable" : `${points} spendable Points`)} aria-label={account.points === null ? "Points balance unavailable" : `${points} spendable Points`}>
          <FigmaIcon name="trophy" size={18} /><span>{points}</span>
        </span>}
        <span className={styles.walletAddress}><FigmaIcon name="wallet" size={18} /><span className={styles.walletLabel}>{account.isConnected ? account.displayAddress ?? "Wallet" : "Connect wallet"}</span></span>
        {!account.isConnected && <span className={styles.walletSpacer} aria-hidden="true" />}
        {account.isConnected && activeCount > 0 && <span className={styles.pending}>{activeCount}</span>}
      </RevampButton>
      </DropdownMenu.Trigger>
      {account.isConnected && <DropdownMenu.Portal container={portalContainer ?? undefined}>
        <DropdownMenu.Content align="end" sideOffset={8} className={styles.walletMenu}>
          <DropdownMenu.Item asChild><Link href="/revamp/profile" prefetch={false} className={styles.walletMenuItem}>My profile</Link></DropdownMenu.Item>
          {isPlatformAdmin && <DropdownMenu.Item asChild><Link href="/revamp/admin" prefetch={false} className={styles.walletMenuItem}>Admin console</Link></DropdownMenu.Item>}
          {isPlatformAdmin && <DropdownMenu.Item asChild><Link href="/platform-admin?tab=protocol" prefetch={false} className={styles.walletMenuItem}>Protocol settings</Link></DropdownMenu.Item>}
          <DropdownMenu.Item className={styles.walletMenuItem} onSelect={() => open()}>Manage wallet</DropdownMenu.Item>
          <DropdownMenu.Item className={styles.walletMenuItem} onSelect={account.refresh}>Refresh points</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>}
      </DropdownMenu.Root>
      <RevampButton variant="secondary" size="icon" disabled className={styles.notifications}
        aria-label="Notifications (coming soon)" title="Notifications are coming soon">
        <FigmaIcon name="bell" />
      </RevampButton>
      <RevampButton variant="secondary" size="icon" className={styles.theme}
        onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
        <RevampIcon name={theme === "dark" ? "sun" : "moon"} />
      </RevampButton>
    </div>
  </header>;
}

export function RevampSiteFooter() {
  return <footer className={styles.footer}>
    <span>© {new Date().getFullYear()} CKBoost</span>
    <div><Link href="/docs" prefetch={false}>Documentation</Link>{"          "}<a href="https://github.com/Alive24/CKBoost" target="_blank" rel="noreferrer">GitHub</a></div>
  </footer>;
}

export function RevampSiteShell({ children }: { children: ReactNode }) {
  return <div className={styles.shell}>
    <a href="#revamp-main" className={styles.skip}>Skip to content</a>
    <RevampSiteHeader />{children}<RevampSiteFooter />
  </div>;
}
