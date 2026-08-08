import { useEffect, useState, useCallback } from "react";
import { FaPlay, FaFilm, FaFolderOpen, FaCheckCircle, FaSpinner, FaSyncAlt, FaTrash, FaDownload } from "react-icons/fa";
import ReplayViewer from "@/components/replay-viewer";
import { useTranslation } from "react-i18next";
import { useDynamicModal } from "@/components/dynamic-modal";
import CustomButton from "@/components/button";

type ReplayFile = {
    name: string;
    path: string;
    size: number;
    modified: number;
    processed: boolean;
};

type ProcessStatus = {
    status: "idle" | "parsing" | "extracting" | "abilities" | "error";
    message?: string;
};

type ReplayData = {
    replayId: string;
    positions: unknown;
    events: unknown;
    meta: unknown;
    abilities: unknown;
    matchDetails?: unknown;
};

const PROGRESS: Record<string, number> = {
    parsing: 33,
    extracting: 66,
    abilities: 90,
};

function formatSize(bytes: number) {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ms: number) {
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

const Replays = () => {
    const [files, setFiles] = useState<ReplayFile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [demosDir, setDemosDir] = useState("");
    const [processing, setProcessing] = useState<Record<string, ProcessStatus>>({});
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeReplay, setActiveReplay] = useState<ReplayData | null>(null);
    const { t } = useTranslation();
    const { showModal, closeModal } = useDynamicModal();

    const STATUS_LABELS: Record<string, string> = {
        parsing: t("replays.parsing"),
        extracting: t("replays.extracting"),
        abilities: t("replays.abilities"),
    };

    const loadFiles = useCallback(() => {
        window.Main.on("replay:list", (msg: string) => {
            window.Main.removeAllListeners("replay:list");
            const res = JSON.parse(msg);
            if (!res.success) { setError(res.error ?? "Failed to list replays"); setLoading(false); return; }
            setFiles(res.files);
            setDemosDir(res.demosDir);
            setLoading(false);
        });
        window.Main.send("replay:list");
    }, []);

    useEffect(() => {
        loadFiles();

        window.Main.on("replay:progress", (msg: string) => {
            const res = JSON.parse(msg) as { path: string; status: string; message: string };
            setProcessing(prev => ({ ...prev, [res.path]: { status: res.status as ProcessStatus["status"], message: res.message } }));
        });

        window.Main.on("replay:process", (msg: string) => {
            const res = JSON.parse(msg) as { success: boolean; path: string; positions?: unknown; events?: unknown; meta?: unknown; abilities?: unknown; matchDetails?: unknown; error?: string };
            if (res.success) {
                setProcessing(prev => {
                    const n = { ...prev };
                    delete n[res.path];
                    return n;
                });
                setFiles(prev => prev.map(f => f.path === res.path ? { ...f, processed: true } : f));
                const replayId = res.path ? res.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.vrf$/i, '') ?? '' : '';
                setActiveReplay({ replayId, positions: res.positions, events: res.events, meta: res.meta, abilities: res.abilities, matchDetails: res.matchDetails });
            } else {
                setProcessing(prev => ({ ...prev, [res.path]: { status: "error", message: res.error ?? "Unknown error" } }));
            }
        });

        return () => {
            window.Main.removeAllListeners("replay:list");
            window.Main.removeAllListeners("replay:progress");
            window.Main.removeAllListeners("replay:process");
            window.Main.removeAllListeners("replay:delete");
        };
    }, [loadFiles]);

    const watch = (file: ReplayFile) => {
        setProcessing(prev => ({ ...prev, [file.path]: { status: "parsing", message: "Starting..." } }));
        window.Main.send("replay:process", file.path);
    };

    const exportRaw = useCallback((file: ReplayFile) => {
        window.Main.removeAllListeners("replay:export-raw");
        window.Main.on("replay:export-raw", () => {
            window.Main.removeAllListeners("replay:export-raw");
        });
        window.Main.send("replay:export-raw", file.path);
    }, []);

    const toggleSelect = (path: string) => {
        setSelected(prev => {
            const n = new Set(prev);
            if (n.has(path)) n.delete(path); else n.add(path);
            return n;
        });
    };

    const deleteOne = (path: string) =>
        new Promise<void>((resolve, reject) => {
            window.Main.removeAllListeners("replay:delete");
            window.Main.on("replay:delete", (msg: string) => {
                window.Main.removeAllListeners("replay:delete");
                const res = JSON.parse(msg);
                if (!res.success) { reject(res.error); return; }
                resolve();
            });
            window.Main.send("replay:delete", path);
        });

    const confirmDeleteSelected = () => {
        const paths = Array.from(selected);
        showModal({
            title: t("replays.deleteSelected"),
            body: (
                <div className="flex flex-col gap-2 pt-1">
                    <p className="text-white text-sm">{t("replays.deleteSelectedConfirm", { count: paths.length })}</p>
                    <p className="text-gray-400 text-xs">{t("replays.deleteReplayDesc")}</p>
                </div>
            ),
            footer: (
                <div className="flex gap-3 w-full">
                    <CustomButton
                        className="flex-1"
                        color="danger"
                        onClickLoading={async () => {
                            for (const path of paths) {
                                await deleteOne(path);
                                setFiles(prev => prev.filter(f => f.path !== path));
                                setProcessing(prev => {
                                    const n = { ...prev };
                                    delete n[path];
                                    return n;
                                });
                            }
                            setSelected(new Set());
                            closeModal();
                        }}
                    >
                        {t("replays.delete")}
                    </CustomButton>
                    <CustomButton className="flex-1" onPress={closeModal}>
                        {t("common.cancel")}
                    </CustomButton>
                </div>
            ),
            onClose: () => {},
        });
    };

    const confirmDelete = (file: ReplayFile) => {
        showModal({
            title: t("replays.deleteReplay"),
            body: (
                <div className="flex flex-col gap-2 pt-1">
                    <p className="text-white text-sm">{t("replays.deleteReplayConfirm", { name: file.name })}</p>
                    <p className="text-gray-400 text-xs">{t("replays.deleteReplayDesc")}</p>
                </div>
            ),
            footer: (
                <div className="flex gap-3 w-full">
                    <CustomButton
                        className="flex-1"
                        color="danger"
                        onClickLoading={() =>
                            new Promise<void>((resolve, reject) => {
                                window.Main.removeAllListeners("replay:delete");
                                window.Main.on("replay:delete", (msg: string) => {
                                    window.Main.removeAllListeners("replay:delete");
                                    const res = JSON.parse(msg);
                                    if (!res.success) { reject(res.error); return; }
                                    setFiles(prev => prev.filter(f => f.path !== file.path));
                                    setProcessing(prev => {
                                        const n = { ...prev };
                                        delete n[file.path];
                                        return n;
                                    });
                                    closeModal();
                                    resolve();
                                });
                                window.Main.send("replay:delete", file.path);
                            })
                        }
                    >
                        {t("replays.delete")}
                    </CustomButton>
                    <CustomButton className="flex-1" onPress={closeModal}>
                        {t("common.cancel")}
                    </CustomButton>
                </div>
            ),
            onClose: () => {},
        });
    };

    if (activeReplay) {
        return (
            <ReplayViewer
                replayId={activeReplay.replayId}
                positions={activeReplay.positions as Parameters<typeof ReplayViewer>[0]["positions"]}
                events={activeReplay.events as Parameters<typeof ReplayViewer>[0]["events"]}
                meta={activeReplay.meta as Parameters<typeof ReplayViewer>[0]["meta"]}
                abilities={activeReplay.abilities as Parameters<typeof ReplayViewer>[0]["abilities"]}
                matchDetails={activeReplay.matchDetails as Parameters<typeof ReplayViewer>[0]["matchDetails"]}
                onClose={() => setActiveReplay(null)}
            />
        );
    }

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400">
                <FaSpinner className="animate-spin text-2xl" />
                <p className="text-sm">{t("replays.loading")}</p>
                <div className="w-48 h-1 rounded-full bg-white/10 overflow-hidden">
                    <div className="h-full bg-cyan-400/60 rounded-full animate-[progress-indeterminate_1.4s_ease-in-out_infinite]" />
                </div>
            </div>
        );
    }

    if (error) {
        return <div className="flex items-center justify-center h-full text-red-400 px-8 text-center">{error}</div>;
    }

    return (
        <div className="flex flex-col h-full p-4 gap-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <FaFilm className="text-cyan-400 text-lg" />
                    <span className="text-white font-semibold">{t("replays.localReplays")}</span>
                    <span className="text-gray-500 text-sm">{t("replays.vrfFiles")}</span>
                </div>
                <div className="flex items-center gap-3">
                    {selected.size > 0 && (
                        <button
                            onClick={confirmDeleteSelected}
                            className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors"
                        >
                            <FaTrash /> {t("replays.removeSelected", { count: selected.size })}
                        </button>
                    )}
                    <button
                        onClick={() => {
                            setLoading(true);
                            setError(null);
                            loadFiles();
                        }}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-cyan-400 transition-colors"
                    >
                        <FaSyncAlt /> {t("replays.reload")}
                    </button>
                    <button
                        onClick={() => window.Main.send("open_url", `file://${demosDir}`)}
                        className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-cyan-400 transition-colors"
                    >
                        <FaFolderOpen /> {t("replays.demosFolder")}
                    </button>
                </div>
            </div>

            {files.length === 0 ? (
                <div className="flex flex-col items-center justify-center flex-1 gap-3 text-gray-500">
                    <FaFilm className="text-4xl opacity-30" />
                    <p className="text-sm">{t("replays.noReplaysFound")}</p>
                    <p className="text-xs font-mono text-gray-600 max-w-xs text-center break-all">{demosDir}</p>
                </div>
            ) : (
                <div className="flex flex-col gap-2 overflow-y-auto">
                    {files.map((file) => {
                        const ps = processing[file.path];
                        const isActive = ps && ps.status !== "error";
                        const isError = ps?.status === "error";
                        const progress = ps ? (PROGRESS[ps.status] ?? 0) : 0;

                        return (
                            <div key={file.path} className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors ${selected.has(file.path) ? "bg-cyan-500/10 hover:bg-cyan-500/15" : "bg-white/5 hover:bg-white/8"}`}>
                                <input
                                    type="checkbox"
                                    checked={selected.has(file.path)}
                                    onChange={() => toggleSelect(file.path)}
                                    disabled={isActive}
                                    className="shrink-0 w-4 h-4 accent-cyan-500 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                                />
                                <FaFilm className="text-lg shrink-0 text-gray-600" />
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm text-white truncate font-medium">{file.name}</div>
                                    <div className="text-xs text-gray-500 flex gap-2">
                                        <span>{formatSize(file.size)}</span>
                                        <span>·</span>
                                        <span>{formatDate(file.modified)}</span>
                                        {file.processed && !isActive && (
                                            <>
                                                <span>·</span>
                                                <span className="text-cyan-600 flex items-center gap-1">
                                                    <FaCheckCircle className="text-xs" /> {t("replays.cached")}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                    {isActive && (
                                        <div className="mt-1.5">
                                            <div className="text-xs text-cyan-400 mb-1 flex items-center gap-1">
                                                <FaSpinner className="animate-spin text-xs" />
                                                {ps.message ?? STATUS_LABELS[ps.status] ?? ps.status}
                                            </div>
                                            <div className="h-1 rounded-full bg-white/10 overflow-hidden w-full">
                                                <div
                                                    className="h-full bg-cyan-400 rounded-full transition-all duration-700 ease-out"
                                                    style={{ width: `${progress}%` }}
                                                />
                                            </div>
                                        </div>
                                    )}
                                    {isError && <div className="text-xs text-red-400 mt-0.5">{ps.message}</div>}
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={() => watch(file)}
                                        disabled={isActive}
                                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                                            isActive
                                                ? "bg-gray-700 text-gray-500 cursor-not-allowed"
                                                : "bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30 border border-cyan-500/30"
                                        }`}
                                    >
                                        {isActive ? <FaSpinner className="animate-spin" /> : <FaPlay className="text-xs" />}
                                        {file.processed ? t("replays.watchCached") : t("replays.watch")}
                                    </button>
                                    {file.processed && !isActive && (
                                        <button
                                            onClick={() => exportRaw(file)}
                                            className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:text-cyan-400 hover:bg-cyan-400/10 transition-colors"
                                            title="Export raw JSON"
                                        >
                                            <FaDownload className="text-xs" />
                                        </button>
                                    )}
                                    <button
                                        onClick={() => confirmDelete(file)}
                                        disabled={isActive}
                                        className="flex items-center justify-center w-7 h-7 rounded text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                        title={t("replays.deleteReplay")}
                                    >
                                        <FaTrash className="text-xs" />
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="text-xs text-gray-600 mt-auto pt-2 border-t border-white/5">
                {t("replays.cacheInfo")}
            </div>
        </div>
    );
};

export default Replays;
