import { useStorage } from "@plasmohq/storage/hook"
import { useEffect, useState } from "react"
import { validateDocprocUrl } from "@/utils/docproc-url"
import { Input, InputNumber, Select, Switch } from "antd"
import { useTranslation } from "react-i18next"

export const SidepanelRag = ({ hideBorder }: { hideBorder?: boolean }) => {
  const { t } = useTranslation("settings")
  const [chatWithWebsiteEmbedding, setChatWithWebsiteEmbedding] = useStorage(
    "chatWithWebsiteEmbedding",
    false
  )
  const [maxWebsiteContext, setMaxWebsiteContext] = useStorage(
    "maxWebsiteContext",
    7028
  )
  const [docprocEnabled, setDocprocEnabled] = useStorage("docprocEnabled", false)
  const [docprocUrl, setDocprocUrl] = useStorage("docprocUrl", "")
  const [docprocMode, setDocprocMode] = useStorage("docprocMode", "reading")
  const [paperLibraryUrl, setPaperLibraryUrl] = useStorage("paperLibraryUrl", "")
  const [libraryDraft, setLibraryDraft] = useState(paperLibraryUrl)
  useEffect(() => setLibraryDraft(paperLibraryUrl), [paperLibraryUrl])
  const libraryInvalid = !!libraryDraft.trim() && !validateDocprocUrl(libraryDraft)
  // Edit locally; validate and save on blur (not on every keystroke).
  const [docprocUrlDraft, setDocprocUrlDraft] = useState(docprocUrl)
  useEffect(() => setDocprocUrlDraft(docprocUrl), [docprocUrl])
  const docprocUrlInvalid =
    !!docprocUrlDraft.trim() && !validateDocprocUrl(docprocUrlDraft)

  return (
    <div>
      <div className="mb-5">
        <h2
          className={`${
            !hideBorder ? "text-base font-semibold leading-7" : "text-md"
          } text-gray-900 dark:text-white`}>
          {t("generalSettings.sidepanelRag.heading")}
        </h2>
        {!hideBorder && (
          <div className="border border-b border-gray-200 dark:border-gray-600 mt-3"></div>
        )}
      </div>
      <div className={`${
        !hideBorder ? "text-sm" : ""
      } space-y-4`}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <span className="text-gray-700  truncate dark:text-neutral-50">
            {t("generalSettings.sidepanelRag.ragEnabled.label")}
          </span>
          <div>
            <Switch
              className="mt-4 sm:mt-0"
              checked={chatWithWebsiteEmbedding}
              onChange={(checked) => setChatWithWebsiteEmbedding(checked)}
            />
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <span className="text-gray-700 truncate dark:text-neutral-50">
            {t("generalSettings.sidepanelRag.maxWebsiteContext.label")}
          </span>
          <div>
            <InputNumber
              className="mt-4 sm:mt-0"
              value={maxWebsiteContext}
              onChange={(value) => setMaxWebsiteContext(value)}
              placeholder={t(
                "generalSettings.sidepanelRag.maxWebsiteContext.placeholder"
              )}
            />
          </div>
        </div>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <span className="text-gray-700 truncate dark:text-neutral-50">
            {t("generalSettings.sidepanelRag.paperLibrary.label")}
          </span>
          <div>
            <Input
              className="mt-4 sm:mt-0 sm:w-72"
              value={libraryDraft}
              status={libraryInvalid ? "error" : undefined}
              onChange={(e) => setLibraryDraft(e.target.value)}
              onBlur={() => {
                const v = validateDocprocUrl(libraryDraft)
                if (v) setPaperLibraryUrl(v)
                else if (!libraryDraft.trim()) setPaperLibraryUrl("")
              }}
              placeholder="http://your-host:8256"
            />
          </div>
        </div>
        {libraryInvalid && (
          <p className="text-red-600 dark:text-red-400">
            {t("generalSettings.sidepanelRag.docproc.invalidUrl")}
          </p>
        )}
        <p className="text-gray-500 dark:text-gray-400">
          {t("generalSettings.sidepanelRag.paperLibrary.help")}
        </p>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <span className="text-gray-700 truncate dark:text-neutral-50">
            {t("generalSettings.sidepanelRag.docproc.label")}
          </span>
          <div>
            <Switch
              className="mt-4 sm:mt-0"
              checked={docprocEnabled}
              onChange={(checked) => setDocprocEnabled(checked)}
            />
          </div>
        </div>
        {docprocEnabled && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
              <span className="text-gray-700 truncate dark:text-neutral-50">
                {t("generalSettings.sidepanelRag.docproc.url")}
              </span>
              <div>
                <Input
                  className="mt-4 sm:mt-0 sm:w-72"
                  value={docprocUrlDraft}
                  status={docprocUrlInvalid ? "error" : undefined}
                  onChange={(e) => setDocprocUrlDraft(e.target.value)}
                  onBlur={() => {
                    const v = validateDocprocUrl(docprocUrlDraft)
                    if (v) setDocprocUrl(v)
                    else if (!docprocUrlDraft.trim()) setDocprocUrl("")
                  }}
                  placeholder="https://docproc.example.com"
                />
              </div>
            </div>
            {docprocUrlInvalid && (
              <p className="text-red-600 dark:text-red-400">
                {t("generalSettings.sidepanelRag.docproc.invalidUrl")}
              </p>
            )}
            <p className="text-gray-500 dark:text-gray-400">
              {t("generalSettings.sidepanelRag.docproc.warning")}
            </p>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
              <span className="text-gray-700 truncate dark:text-neutral-50">
                {t("generalSettings.sidepanelRag.docproc.mode")}
              </span>
              <div>
                <Select
                  className="mt-4 sm:mt-0 sm:w-72"
                  value={docprocMode}
                  onChange={(value) => setDocprocMode(value)}
                  options={[
                    {
                      value: "reading",
                      label: t("generalSettings.sidepanelRag.docproc.reading")
                    },
                    {
                      value: "full",
                      label: t("generalSettings.sidepanelRag.docproc.full")
                    }
                  ]}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
