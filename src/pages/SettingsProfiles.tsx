import { listenEvent, reportIpcError } from "@/util/ipc";
import { invoke, isTauri } from "@tauri-apps/api/core";
import CustomButton from "@/components/button.tsx";
import { useDynamicModal } from "@/components/dynamic-modal.tsx";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer.tsx";
import { PageHeader, SectionCard, SectionRow, pageBodyClass } from "@/components/section-card";
import { SettingsDiffViewer } from "@/components/settings-diff-viewer.tsx";
import { Profile } from "@/types/profile.ts";
import formatUnixMillis from "@/util/format-date.ts";
import { Input, Label, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { FaEdit } from "react-icons/fa";
import { FaCodeCompare, FaCopy, FaEye, FaPlus, FaShare, FaTrash, FaTriangleExclamation } from "react-icons/fa6";
import { LuSlidersHorizontal, LuUsers } from "react-icons/lu";
import { getData } from "@/util/share.ts";
import { useTranslation, Trans } from "react-i18next";

const ViewSettingsModalBody = ({ data }: { data: any }) => (
	<ParsedSettingsViewer rawSettings={data?.settings} crosshairData={data?.crosshairs ?? null} />
);

/** Compact icon action sitting at the right of a profile row. */
const iconButtonClass = "min-w-8 px-2";

const SettingsProfiles = () => {
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const { showModal, closeModal } = useDynamicModal();
	const { t } = useTranslation();

	const refreshProfiles = () => {
		invoke<{ profiles: Profile[] }>("settings_profile_list").then(reply => setProfiles(reply.profiles)).catch(reportIpcError);
	};

	const compareProfileWithCurrent = (profileName: string, resolve: () => void, reject: (e: string) => void) => {
		const onSavedSettings = (msgA: any) => {

			const dataA = msgA;
			if (dataA.error) { reject(dataA.error); return; }
			const onCurrentSettings = (msgB: any) => {

				const dataB = msgB;
				if (dataB.error) { reject(dataB.error); return; }
				showModal({
					title: t("profiles.settingsDiff"),
					body: <SettingsDiffViewer nameA={profileName} nameB={t("profiles.currentAccount")} rawA={dataA.settings} rawB={dataB.settings} />,
					footer: (
						<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
							{t("common.close")}
						</CustomButton>
					),
					onClose: resolve,
				});
			};
			invoke<any>("settings_current_view").then(onCurrentSettings).catch(error => onCurrentSettings({ success: false, error: String(error) }));
		};
		invoke<any>("settings_profile_view", { args: [profileName] }).then(onSavedSettings).catch(error => onSavedSettings({ success: false, error: String(error) }));
	};

	const compareTwoProfiles = (nameA: string, nameB: string, resolve: () => void, reject: (e: string) => void) => {
		const onFirstProfile = (msgA: any) => {

			const dataA = msgA;
			if (dataA.error) { reject(dataA.error); return; }
			const onSecondProfile = (msgB: any) => {

				const dataB = msgB;
				if (dataB.error) { reject(dataB.error); return; }
				showModal({
					title: t("profiles.settingsDiff"),
					body: <SettingsDiffViewer nameA={nameA} nameB={nameB} rawA={dataA.settings} rawB={dataB.settings} />,
					footer: (
						<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
							{t("common.close")}
						</CustomButton>
					),
					onClose: resolve,
				});
			};
			invoke<any>("settings_profile_view", { args: [nameB] }).then(onSecondProfile).catch(error => onSecondProfile({ success: false, error: String(error) }));
		};
		invoke<any>("settings_profile_view", { args: [nameA] }).then(onFirstProfile).catch(error => onFirstProfile({ success: false, error: String(error) }));
	};

	useEffect(() => {
		let active = true;

		if (isTauri()) {
			const applyProfiles = (message: any) => {
				if (message.profiles) setProfiles(message.profiles);
			}; const unlistenapplyProfiles = listenEvent("settings:profile:list", applyProfiles);
			invoke<{ profiles: Profile[] }>("settings_profile_list").then(reply => { if (active) return (reply => setProfiles(reply.profiles))(reply); }).catch(error => { if (active) return (reportIpcError)(error); });
			return () => {
				unlistenapplyProfiles();
			};
		}

		return () => { active = false; };
}, []);

	// --- Actions ------------------------------------------------------------
	// Each returns the promise CustomButton drives its pending state from.

	const addProfile = () =>
		new Promise<void>((resolve_1, reject_1) => {
			invoke("analytics_track", { args: ["profile:add", "{}"] }).catch(reportIpcError);
			showModal({
				title: t("profiles.addProfile"),
				body: (
					<div className={"flex flex-col gap-5 pt-2"}>
						<CustomButton
							onClickLoading={() => {
								return new Promise<void>((resolve, reject) => {
									if (isTauri()) {
										invoke("analytics_track", { args: ["profile:add:load_account", "{}"] }).catch(reportIpcError);
										const onAccountProfileAdded = (message: any) => {

											const rawData = message;
											if (rawData.error) {
												reject(rawData.error);
												reject_1();
												return;
											}
											refreshProfiles();
											resolve();
											closeModal();
											resolve_1();
										};
										invoke<any>("settings_profile_add", { args: ["current"] }).then(onAccountProfileAdded).catch(reject);
									} else {
										reject("Tauri is unavailable");
									}
								});
							}}
						>
							{t("profiles.loadFromAccount")}
						</CustomButton>
						<div className={"flex items-center gap-3"}>
							<span className={"h-px flex-1 bg-white/10"} />
							<span className={"text-xs uppercase tracking-wider text-gray-500"}>{t("profiles.or")}</span>
							<span className={"h-px flex-1 bg-white/10"} />
						</div>
						<div className={"flex items-end gap-3"}>
							<TextField className={"flex-1"}>
								<Label>{t("profiles.shareCode")}</Label>
								<Input id={"share-code"} placeholder={t("profiles.shareCodePlaceholder")} />
							</TextField>
							<CustomButton
								className={"shrink-0"}
								onClickLoading={async () => {

									invoke("analytics_track", { args: ["profile:add:load_share", "{}"] }).catch(reportIpcError);
									const input = window.document.getElementById("share-code") as HTMLInputElement;
									const inputData = input.value.trim();
									if (!inputData) throw t("profiles.noInputData");
									if (inputData.length != 10) throw t("profiles.invalidShareCode");

									const data = await getData(inputData);
									if (!data) throw t("profiles.invalidDataReturned");

									return new Promise<void>((resolve, reject) => {
										const save = () => {
											const onSharedProfileAdded = (message: any) => {

												const rawData = message;
												if (rawData.error) {
													reject(rawData.error);
													reject_1();
													return;
												}
												refreshProfiles();
												resolve();
												closeModal();
												resolve_1();
											};
											invoke<any>("settings_profile_add", { args: [data] }).then(onSharedProfileAdded).catch(reject);
										};

										const match = !data.match(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
										if (data.length < 2500 || match) {
											invoke("analytics_track", { args: ["profile:add:load_clipboard:error", JSON.stringify({ length: data.length, match })] }).catch(reportIpcError);
											showModal({
												title: t("profiles.doesntLookLikeProfile"),
												body: t("profiles.doesntLookLikeProfileBody"),
												footer: (
													<>
														<CustomButton
															className={"mr-4"}
															color={"danger"}
															onPress={() => {
																closeModal();
																reject();
																reject_1();
															}}
														>
															{t("common.cancel")}
														</CustomButton>
														<CustomButton onPress={save}>
															{t("common.continue")}
														</CustomButton>
													</>
												),
												onClose: () => {
													reject();
													reject_1();
												},
											});
										} else {
											save();
										}
									});
								}}
							>
								<FaPlus />
							</CustomButton>
						</div>
					</div>
				),
				footer: (
					<CustomButton
						className={"w-full"}
						color={"danger"}
						onPress={() => {
							closeModal();
							reject_1();
						}}
					>
						{t("common.cancel")}
					</CustomButton>
				),
				onClose: () => {
					resolve_1();
				},
			});
		});

	const loadProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (isTauri()) {
				invoke("analytics_track", { args: ["profile:load", "{}"] }).catch(reportIpcError);
				const onProfileLoaded = (message: any) => {

					const rawData = message;
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					showModal({
						title: t("profiles.loadSuccess"),
						body: (
							<div className="glass p-4">
								<p className="text-green-400 font-semibold text-center">
									{t("profiles.loadSuccessMessage", { name: profile.name })}
								</p>
								<p className="text-sm text-gray-300 text-center mt-2">{t("profiles.loadSuccessDetail")}</p>
							</div>
						),
						footer: (
							<CustomButton className="w-full" color="success" onPress={closeModal}>
								{t("common.close")}
							</CustomButton>
						),
					});
					resolve();
				};
				invoke<any>("settings_profile_load", { args: [profile.name] }).then(onProfileLoaded).catch(reject);
			} else {
				reject("Tauri is unavailable");
			}
		});

	const renameProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			showModal({
				title: t("profiles.editProfile"),
				body: (
					<div id={"edit-profile-div"}>
						<TextField defaultValue={profile.name}>
							<Label>{t("common.name")}</Label>
							<Input />
						</TextField>
					</div>
				),
				footer: (
					<>
						<CustomButton
							className={"mr-4"}
							color={"danger"}
							onPress={() => {
								closeModal();
								resolve();
							}}
						>
							{t("common.cancel")}
						</CustomButton>
						<CustomButton
							onPress={() => {
								if (isTauri()) {
									invoke("analytics_track", { args: ["profile:edit", "{}"] }).catch(reportIpcError);
									const onProfileRenamed = (message: any) => {

										const rawData = message;
										if (!rawData.success) {
											reject(rawData.error);
											return;
										}
										refreshProfiles();
										resolve();
										closeModal();
									};
									const document = window.document.getElementById("edit-profile-div");
									if (!document) {
										reject("No document");
										return;
									}
									const input = document.querySelector("input");
									if (!input) {
										reject("No input found");
										return;
									}
									invoke<any>("settings_profile_rename", { args: [profile.name, input.value] }).then(onProfileRenamed).catch(reject);
								} else {
									reject("Tauri is unavailable");
								}
							}}
						>
							{t("common.save")}
						</CustomButton>
					</>
				),
				onClose: () => {
					resolve();
				},
			});
		});

	const duplicateProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (isTauri()) {
				invoke("analytics_track", { args: ["profile:duplicate", "{}"] }).catch(reportIpcError);
				const onProfileDuplicated = (message: any) => {

					const rawData = message;
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					refreshProfiles();
					resolve();
				};
				invoke<any>("settings_profile_duplicate", { args: [profile.name] }).then(onProfileDuplicated).catch(reject);
			} else {
				reject("Tauri is unavailable");
			}
		});

	const viewProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (isTauri()) {
				invoke("analytics_track", { args: ["profile:view", "{}"] }).catch(reportIpcError);
				const onProfileViewed = (message: any) => {
					const rawData = message;
					if (rawData.error) {
						reject(rawData.error);

						return;
					}
					showModal({
						title: t("settingsViewer.modalTitle", { name: profile.name }),
						body: <ViewSettingsModalBody data={rawData} />,
						footer: (
							<CustomButton
								className="w-full"
								color="danger"
								onPress={() => {
									closeModal();
									resolve();
								}}
							>
								{t("common.close")}
							</CustomButton>
						),
						onClose: () => {
							resolve();
						},
					});

				};
				invoke<any>("settings_profile_view", { args: [profile.name] }).then(onProfileViewed).catch(reject);
			} else {
				reject("Tauri is unavailable");
			}
		});

	const compareProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			const otherProfiles = profiles.filter((p) => p.name !== profile.name);
			showModal({
				title: t("profiles.compareWith", { name: profile.name }),
				body: (
					<div className="flex flex-col gap-2 pt-2">
						<CustomButton
							className="w-full"
							color="secondary"
							onPress={() => {
								closeModal();
								compareProfileWithCurrent(profile.name, resolve, reject);
							}}
						>
							{t("profiles.currentAccount")}
						</CustomButton>
						{otherProfiles.map((other) => (
							<CustomButton
								key={other.name}
								className="w-full"
								onPress={() => {
									closeModal();
									compareTwoProfiles(profile.name, other.name, resolve, reject);
								}}
							>
								{other.name}
							</CustomButton>
						))}
					</div>
				),
				footer: (
					<CustomButton className="w-full" color="danger" onPress={() => { closeModal(); resolve(); }}>
						{t("common.cancel")}
					</CustomButton>
				),
				onClose: () => resolve(),
			});
		});

	const shareProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (isTauri()) {
				invoke("analytics_track", { args: ["profile:share", "{}"] }).catch(reportIpcError);
				const onProfileShared = (message: any) => {

					const rawData = message;
					if (rawData.error) {
						reject(rawData.error);
						return;
					}
					showModal({
						title: t("profiles.shareProfile"),
						body: (
							<div className={"pt-4"}>
								<TextField defaultValue={rawData.code} isReadOnly>
									<Label>{t("profiles.shareCode")}</Label>
									<Input />
								</TextField>
								<span className={"text-gray-400"}>{t("profiles.shareExpiry")}</span>
							</div>
						),
						footer: (
							<>
								<CustomButton
									className={"w-full"}
									onClickLoading={() => {
										return new Promise<void>((resolve, reject) => {
											if (isTauri()) {
												invoke("analytics_track", { args: ["profile:share:copy", "{}"] }).catch(reportIpcError);
												invoke<void>("clipboard_set", { args: [rawData.code] }).then(resolve).catch(reject);
											} else {
												reject("Tauri is unavailable");
											}
										});
									}}
								>
									{t("common.copy")}
								</CustomButton>
								<CustomButton
									className={"w-full"}
									color={"danger"}
									onPress={() => {
										closeModal();
										resolve();
									}}
								>
									{t("common.close")}
								</CustomButton>
							</>
						),
					});
					resolve();
				};
				invoke<any>("settings_profile_share", { args: [profile.name] }).then(onProfileShared).catch(reject);
			} else {
				reject("Tauri is unavailable");
			}
		});

	const confirmRemoveProfile = (profile: Profile) => {
		showModal({
			title: t("profiles.confirmDeleteTitle"),
			body: t("profiles.confirmDeleteBody", { name: profile.name }),
			footer: (
				<>
					<CustomButton color="secondary" onPress={closeModal}>{t("common.cancel")}</CustomButton>
					<CustomButton color="danger" onClickLoading={async () => {
						await removeProfile(profile);
						closeModal();
					}}>{t("profiles.delete")}</CustomButton>
				</>
			),
		});
	};

	const removeProfile = (profile: Profile) =>
		new Promise<void>((resolve, reject) => {
			if (isTauri()) {
				invoke("analytics_track", { args: ["profile:remove", "{}"] }).catch(reportIpcError);
				const onProfileRemoved = (message: any) => {

					const rawData = message;
					if (rawData.error || !rawData.success) {
						reject(rawData.error ?? "Failed to remove profile");
						return;
					}
					refreshProfiles();
					resolve();
				};
				invoke<any>("settings_profile_remove", { args: [profile.name] }).then(onProfileRemoved).catch(reject);
			} else {
				reject("Tauri is unavailable");
			}
		});

	// --- Render -------------------------------------------------------------

	return (
		<div className="h-full flex flex-col animate-fade-in">
			<PageHeader
				icon={<LuSlidersHorizontal className="text-lg" />}
				title={t("profiles.title")}
				subtitle={t("profiles.savedCount", { count: profiles.length })}
			>
				<CustomButton size="sm" onClickLoading={addProfile}>
					<FaPlus />
					{t("profiles.addProfile")}
				</CustomButton>
			</PageHeader>

			<div className={pageBodyClass}>
				{/* Load only applies on the next game launch, so this needs to stay visible. */}
				<div className="panel px-4 py-3 flex items-center gap-3">
					<FaTriangleExclamation className="text-(--signal-warn) shrink-0" />
					<p className="text-[12px] text-(--text-secondary)">
						<Trans i18nKey="profiles.gameClosedWarning" components={{ bold: <b className="text-amber-300 font-semibold" /> }} />
					</p>
				</div>

				{profiles.length === 0 ? (
					<div className="flex-1 flex flex-col items-center justify-center gap-2 text-(--text-muted)">
						<LuUsers className="text-4xl opacity-30" />
						<p className="text-[12px] text-(--text-secondary)">{t("profiles.noProfilesYet")}</p>
						<p className="text-[11px]">
							<Trans i18nKey="profiles.noProfilesHint" components={{ bold: <b className="text-(--text-secondary)" /> }} />
						</p>
					</div>
				) : (
					<SectionCard title={t("profiles.savedProfiles")} count={profiles.length} accent="#ff4655">
						{profiles.map((profile) => (
							<SectionRow key={profile.name}>
								<div className="w-8 h-8 rounded-[6px] bg-(--control) border border-(--border) flex items-center justify-center text-(--accent-selected) shrink-0">
									<LuSlidersHorizontal className="text-[13px]" />
								</div>
								<div className="min-w-0 flex-1">
									<p className="text-[12px] font-medium text-(--text-primary) truncate">{profile.name}</p>
									<p className="text-[11px] text-(--text-muted)">{formatUnixMillis(profile.created)}</p>
								</div>
								<div className="flex items-center gap-1 shrink-0">
									<CustomButton size="sm" className="mr-1" onClickLoading={() => loadProfile(profile)}>
										{t("common.load")}
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.editProfile")} onClickLoading={() => renameProfile(profile)}>
										<FaEdit />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.duplicate")} onClickLoading={() => duplicateProfile(profile)}>
										<FaCopy />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.view")} onClickLoading={() => viewProfile(profile)}>
										<FaEye />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.settingsDiff")} onClickLoading={() => compareProfile(profile)}>
										<FaCodeCompare />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} aria-label={t("profiles.shareProfile")} onClickLoading={() => shareProfile(profile)}>
										<FaShare />
									</CustomButton>
									<CustomButton size="sm" className={iconButtonClass} color="danger" aria-label={t("profiles.delete")} onPress={() => confirmRemoveProfile(profile)}>
										<FaTrash />
									</CustomButton>
								</div>
							</SectionRow>
						))}
					</SectionCard>
				)}
			</div>
		</div>
	);
};

export default SettingsProfiles;
