import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { zh } from "../../i18n";
import { platformLabel, type AppInfo } from "../../core/appInfo";
import BrandMark from "./BrandMark";
import Modal from "./Modal";

/** 官方联系方式。仓库地址和「帮助」菜单里的 REPO_URL 保持同一个事实来源——那里也改。 */
const SITE_URL = "https://fanggame.company";
const GH_USER_URL = "https://github.com/xiaofangstudio";
const REPO_URL = "https://github.com/xiaofangstudio/starta";
const MAIL_QQ = "2053337326@qq.com";
const MAIL_OUTLOOK = "xiaofangstudio@outlook.com";
const QQ_NUMBER = "1079937215";

/** 两种信息浮层：快捷键速览 / 关于 Strata。 */
export type InfoModalKind = "shortcuts" | "about" | null;

interface Props {
  which: InfoModalKind;
  onClose: () => void;
  /** 运行环境信息；拿不到时按降级文案展示。 */
  info: AppInfo | null;
}

/**
 * 开始页面与编辑壳共用的信息浮层。
 *
 * 两个页面都要能在「帮助」里查到快捷键与关于信息，内容完全一致，
 * 因此抽成一个组件，避免同一份文案在两处维护、两处走样。
 */
export default function InfoModals({ which, onClose, info }: Props) {
  if (which === "shortcuts") {
    return (
      <Modal
        title={zh.shortcuts.title}
        onClose={onClose}
        footer={
          <button className="btn-primary" onClick={onClose}>
            {zh.shortcuts.close}
          </button>
        }
      >
        <p className="modal-lead">{zh.shortcuts.hint}</p>
        <ul className="keys">
          {zh.shortcuts.rows.map((r) => (
            <li key={r.keys} className="keys-row">
              <kbd className="kbd">{r.keys}</kbd>
              <span>{r.desc}</span>
            </li>
          ))}
        </ul>
      </Modal>
    );
  }

  if (which === "about") {
    const facts = [
      { k: "产品", v: zh.app.name },
      { k: "版本", v: info ? `v${info.version}` : "读取中…" },
      { k: "运行环境", v: platformLabel(info) },
      { k: "界面语言", v: "简体中文" },
      { k: "协议", v: "MIT · 永久免费 · 不盈利" },
      { k: "仓库", v: "github.com/xiaofangstudio/starta" },
    ];

    return (
      <Modal
        title={zh.about.title}
        onClose={onClose}
        width={520}
        footer={
          <button className="btn-primary" onClick={onClose}>
            {zh.about.close}
          </button>
        }
      >
        <div className="about-head">
          <BrandMark size={52} />
          <div>
            <p className="about-name">{zh.app.name}</p>
            <p className="about-studio">
              {zh.app.studio}
              {info ? ` · v${info.version}` : ""}
            </p>
          </div>
        </div>
        <p className="modal-lead">{zh.about.intro}</p>
        <dl className="facts">
          {facts.map((f) => (
            <div key={f.k} className="fact">
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
        <p className="about-noai">{zh.about.noAi}</p>

        {/*
          联系我们：按「去哪儿」分四行，而不是把六条信息平铺成一坨。
          每行一个去处：官网 / GitHub / 邮箱 / QQ —— 左边是索引，右边是动作。
          外链用 openUrl（Tauri 的 opener 走系统浏览器），邮箱走 mailto。
          QQ 号这种"要抄走"的东西给一键复制，不让人圈选半天。
        */}
        <ContactSection />

        {/* 免责声明：关于页只放要点，完整版在仓库 DISCLAIMER.md */}
        <section className="about-disclaimer">
          <h4 className="about-disclaimer-title">{zh.about.disclaimerTitle}</h4>
          <ul>
            {zh.about.disclaimer.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <p className="about-disclaimer-full">{zh.about.disclaimerFull}</p>
        </section>
      </Modal>
    );
  }

  return null;
}

/* ---------------------------------------------------------------- 联系我们 */

function ContactSection() {
  /** QQ 复制成功的反馈：短暂变"已复制"，1.5 秒后还原。 */
  const [copied, setCopied] = useState(false);

  const copyQQ = async () => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(QQ_NUMBER);
      ok = true;
    } catch {
      // WebView 里 clipboard API 被权限挡住时退回老办法
      try {
        const el = document.createElement("textarea");
        el.value = QQ_NUMBER;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        ok = document.execCommand("copy");
        el.remove();
      } catch {
        ok = false;
      }
    }
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  return (
    <section className="about-contact">
      <h4 className="about-contact-title">联系我们</h4>
      <div className="about-crows">
        <div className="about-crow">
          <span className="about-ck">官网</span>
          <button
            type="button"
            className="about-cl"
            title="在浏览器打开"
            onClick={() => void openUrl(SITE_URL)}
          >
            fanggame.company
          </button>
        </div>

        <div className="about-crow">
          <span className="about-ck">GitHub</span>
          <div className="about-cvs">
            <button
              type="button"
              className="about-cl"
              title="在浏览器打开"
              onClick={() => void openUrl(GH_USER_URL)}
            >
              个人主页
            </button>
            <button
              type="button"
              className="about-cl"
              title="在浏览器打开"
              onClick={() => void openUrl(REPO_URL)}
            >
              Strata 仓库
            </button>
          </div>
        </div>

        <div className="about-crow">
          <span className="about-ck">邮箱</span>
          <div className="about-cvs">
            <button
              type="button"
              className="about-cl"
              title="写邮件"
              onClick={() => void openUrl(`mailto:${MAIL_QQ}`)}
            >
              {MAIL_QQ}
            </button>
            <button
              type="button"
              className="about-cl"
              title="写邮件"
              onClick={() => void openUrl(`mailto:${MAIL_OUTLOOK}`)}
            >
              {MAIL_OUTLOOK}
            </button>
          </div>
        </div>

        <div className="about-crow">
          <span className="about-ck">QQ</span>
          <span className="about-cq u-num">{QQ_NUMBER}</span>
          <button
            type="button"
            className={`about-copy${copied ? " is-done" : ""}`}
            onClick={() => void copyQQ()}
            title="复制 QQ 号"
          >
            {copied ? "已复制 ✓" : "复制"}
          </button>
        </div>
      </div>
    </section>
  );
}
