import CustomButton from "@/components/button";
import { useDynamicModal } from "@/components/dynamic-modal";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer";
import { useEffect, useState } from "react";
import { FaEye } from "react-icons/fa6";
import { useTranslation } from "react-i18next";

type Status = "loading" | "offline" | "online";

type StatusInfo = {
	status: Status;
	username?: string;
};

const dot: Record<Status, string> = {
	loading: "bg-yellow-400 animate-pulse",
	offline: "bg-red-500",
	online: "bg-green-400",
};

const RiotStatusBar = () => {
	const [info, setInfo] = useState<StatusInfo>({ status: "loading" });
	const { showModal, closeModal } = useDynamicModal();
	const { t } = useTranslation();

	const label: Record<Status, string> = {
		loading: t("riotStatus.connecting"),
		offline: t("riotStatus.offline"),
		online: "",
	};

	const fetchStatus = () => {
		if (!window.Main) return;
		window.Main.removeAllListeners("userinfo:get");
		window.Main.on("userinfo:get", (message: string) => {
			window.Main.removeAllListeners("userinfo:get");
			const data = JSON.parse(message);
			if (data.error || !data.acct) {
				setInfo({ status: "offline" });
				return;
			}
			setInfo({
				status: "online",
				username: `${data.acct.game_name}#${data.acct.tag_line}`,
			});
		});
		window.Main.send("userinfo:get");
	};

	useEffect(() => {
		fetchStatus();
		const interval = setInterval(fetchStatus, 10000);
		return () => {
			clearInterval(interval);
			window.Main.removeAllListeners("userinfo:get");
		};
	}, []);

	return (
		<div className="flex items-center gap-1.5 text-sm select-none">
			<span className={`w-2 h-2 rounded-full shrink-0 ${dot[info.status]}`} />
			<span className="text-gray-300 truncate max-w-45">
				{info.status === "online" ? info.username : label[info.status]}
			</span>
			{info.status === "online" && (
				<CustomButton
					size="sm"
					showStatusColor={false}
					modalOnError={false}
					className="min-w-0 w-7 h-7 p-0 ml-1 text-gray-400"
					onClickLoading={() =>
						new Promise<void>((resolve, reject) => {
							window.Main.removeAllListeners("settings:current:view");
							window.Main.on("settings:current:view", (message: string) => {
								window.Main.removeAllListeners("settings:current:view");
								const data = JSON.parse(message);
								if (data.error) {
									reject(data.error);
									return;
								}
								showModal({
									title: `Settings — ${info.username}`,
									body: (
										<ParsedSettingsViewer
											rawSettings={data.settings}
											crosshairData={data.crosshairs ?? null}
										/>
									),
									footer: (
										<CustomButton
											className="w-full"
											color="danger"
											showStatusColor={false}
											onPress={() => {
												closeModal();
												resolve();
											}}
										>
											{t("common.close")}
										</CustomButton>
									),
									onClose: resolve,
								});
							});
							window.Main.send("settings:current:view");
						})
					}
				>
					<FaEye />
				</CustomButton>
			)}
		</div>
	);
};

export default RiotStatusBar;
