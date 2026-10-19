import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

const ISSUE_URL = "https://github.com/TheCommonAI/common-desktop/issues/new";

export default function Feedback() {
  const [error, setError] = useState<string | null>(null);

  const openIssueForm = () => {
    setError(null);
    if ("__TAURI_INTERNALS__" in window) {
      void openUrl(ISSUE_URL).catch((reason: unknown) => setError(String(reason)));
      return;
    }
    const opened = window.open(ISSUE_URL, "_blank");
    if (opened === null) {
      setError("The issue form couldn't be opened.");
    } else {
      opened.opener = null;
    }
  };

  return (
    <div className="feedback">
      <button type="button" className="feedback__button" onClick={openIssueForm}>
        Feedback / report an issue
      </button>
      <p className="feedback__note" role="status">
        {error}
      </p>
    </div>
  );
}
