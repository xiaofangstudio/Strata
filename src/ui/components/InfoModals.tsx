import { zh } from "../../i18n/zh-CN";
import { platformLabel, type AppInfo } from "../../core/appInfo";
import BrandMark from "./BrandMark";
import Modal from "./Modal";

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
      { k: "仓库", v: "github.com/xiaofangstudio/Strata" },
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
      </Modal>
    );
  }

  return null;
}
