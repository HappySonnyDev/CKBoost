"use client";

import type {ReactNode} from "react";
import Link from "next/link";
import {RevampSiteShell} from "./site-shell";
import {ADMIN_NAVIGATION} from "@/lib/revamp/admin-navigation";
import styles from "./admin-overview.module.css";

/** Shared Figma Admin frame. Inner modules own their content and data access. */
export function AdminSectionShell({title, description, activeTab, children}: {
  title: string;
  description: string;
  activeTab: "overview" | "campaigns" | "users" | "tipping" | "rewards";
  children: ReactNode;
}) {
  return <RevampSiteShell><main id="revamp-main" className={styles.main}>
    <header className={styles.hero}>
      <img src="/assets/revamp/admin-space.svg" width="1440" height="140" alt="" className={styles.space} />
      <div className={styles.heroContent}><div className={styles.heroTitles}>
        <span className={styles.adminLabel}>Platform Admin</span><h1>{title}</h1><p>{description}</p>
      </div><img src="/assets/revamp/admin-rabbit.svg" width="151" height="83" alt="" className={styles.rabbit} /></div>
    </header>
    <div className={styles.container}>
      <nav className={styles.tabs} aria-label="Admin navigation">{ADMIN_NAVIGATION.map(tab => <Link key={tab.id} href={tab.href} prefetch={false} aria-current={activeTab === tab.id ? "page" : undefined}>{tab.label}</Link>)}</nav>
      {children}
    </div>
  </main></RevampSiteShell>;
}
