import CustomButton from "@/components/button.tsx";
import { useDynamicModal } from "@/components/dynamic-modal.tsx";
import { ParsedSettingsViewer } from "@/components/parsed-settings-viewer.tsx";
import { SettingsDiffViewer } from "@/components/settings-diff-viewer.tsx";
import { Profile } from "@/types/profile.ts";
import formatUnixMillis from "@/util/format-date.ts";
import { Input, Label, Table, TextField } from "@heroui/react";
import { useEffect, useState } from "react";
import { FaEdit } from "react-icons/fa";
import { FaCodeCompare, FaCopy, FaEye, FaPlus, FaShare, FaTrash, FaUsers } from "react-icons/fa6";
import { getData } from "../../electron/util/share.ts";
import { useTranslation, Trans } from "react-i18next";

const ViewSettingsModalBody = ({ data }: { data: any }) => (
	<ParsedSettingsViewer rawSettings={data?.settings} crosshairData={data?.crosshairs ?? null} />
);

const SettingsProfiles = () => {
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const { showModal, closeModal } = useDynamicModal();
	const { t } = useTranslation();

	const refreshProfiles = () => {
		window.Main.send("settings:profile:list");
	};

	const compareProfileWithCurrent = (profileName: string, resolve: () => void, reject: (e: string) => void) => {
		window.Main.on("settings:profile:view", (msgA: string) => {
			window.Main.removeAllListeners("settings:profile:view");
			const dataA = JSON.parse(msgA);
			if (dataA.error) { reject(dataA.error); return; }
			window.Main.on("settings:current:view", (msgB: string) => {
				window.Main.removeAllListeners("settings:current:view");
				const dataB = JSON.parse(msgB);
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
			});
			window.Main.send("settings:current:view");
		});
		window.Main.send("settings:profile:view", profileName);
	};

	const compareTwoProfiles = (nameA: string, nameB: string, resolve: () => void, reject: (e: string) => void) => {
		window.Main.on("settings:profile:view", (msgA: string) => {
			window.Main.removeAllListeners("settings:profile:view");
			const dataA = JSON.parse(msgA);
			if (dataA.error) { reject(dataA.error); return; }
			window.Main.on("settings:profile:view", (msgB: string) => {
				window.Main.removeAllListeners("settings:profile:view");
				const dataB = JSON.parse(msgB);
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
			});
			window.Main.send("settings:profile:view", nameB);
		});
		window.Main.send("settings:profile:view", nameA);
	};

	useEffect(() => {
		if (window.Main) {
			window.Main.on("settings:profile:list", (message: string) => {
				setProfiles(JSON.parse(message).profiles);
			});
			window.Main.send("settings:profile:list");
			return () => {
				window.Main.removeAllListeners("settings:profile:list");
			};
		}
	}, []);

	return (
		<div className="px-6 py-8 h-full min-h-0 overflow-hidden flex flex-col animate-fade-in">
			<div className="glass-strong p-6 mb-6 card-hover shrink-0">
				<div className="flex items-center justify-between flex-wrap gap-4">
					<h1 className="text-5xl font-bold gradient-text">{t("profiles.title")}</h1>
					<CustomButton
						onClickLoading={() => {
							return new Promise<void>((resolve_1, reject_1) => {
								window.Main.send("analytics:track", "profile:add", "{}");
								showModal({
									title: t("profiles.addProfile"),
									body: (
										<div className={"flex flex-col gap-4"}>
											<CustomButton
												onClickLoading={() => {
													return new Promise<void>((resolve, reject) => {
														if (window.Main) {
															window.Main.send("analytics:track", "profile:add:load_account", "{}");
															window.Main.on("settings:profile:add", (message: string) => {
																window.Main.removeAllListeners("settings:profile:add");
																const rawData = JSON.parse(message);
																if (rawData.error) {
																	reject(rawData.error);
																	reject_1();
																	return;
																}
																refreshProfiles();
																resolve();
																closeModal();
																resolve_1();
															});
															window.Main.send("settings:profile:add", "current");
														} else {
															reject("No window.Main");
														}
													});
												}}
											>
												{t("profiles.loadFromAccount")}
											</CustomButton>
											<div className={"flex-row flex h-full"}>
												<TextField className={"w-4/5"}>
													<Label>{t("profiles.shareCode")}</Label>
													<Input id={"share-code"} />
												</TextField>
												<CustomButton
													className={
														"h-full w-fit ml-4 " + "py-5"
													}
													onClickLoading={() => {
														return new Promise<void>(async (resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:add:load_share", "{}");
																const input = window.document.getElementById("share-code") as HTMLInputElement;
																const inputData = input.value;
																if (!inputData) {
																	reject(t("profiles.noInputData"));
																	return;
																}
																if (inputData.length != 10) {
																	reject(t("profiles.invalidShareCode"));
																	return;
																}
																const data = await getData(inputData);
																if (!data) {
																	reject(t("profiles.invalidDataReturned"));
																}
																const save = () => {
																	window.Main.on("settings:profile:add", (message: string) => {
																		window.Main.removeAllListeners("settings:profile:add");
																		const rawData = JSON.parse(message);
																		if (rawData.error) {
																			reject(rawData.error);
																			reject_1();
																			return;
																		}
																		refreshProfiles();
																		resolve();
																		closeModal();
																		resolve_1();
																	});
																	window.Main.send("settings:profile:add", "clipboard");
																};
																const match = !data.match(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
																if (data.length < 2500 || match) {
																	window.Main.send(
																		"analytics:track",
																		"profile:add:load_clipboard:error",
																		JSON.stringify({ length: data.length, match }),
																	);
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
																				<CustomButton onPress={() => { save(); }}>
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
															} else {
																reject("No window.Main");
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
						}}
					>
						<FaPlus />
						{t("common.add")}
					</CustomButton>
				</div>
			</div>
			<div className="glass p-4 mb-6 shrink-0">
				<p className="text-center text-gray-300">
					<Trans
						i18nKey="profiles.gameClosedWarning"
						components={{ bold: <b className="text-red-400 font-bold" /> }}
					/>
				</p>
			</div>

			<div className="glass-strong p-6 flex-1 flex flex-col min-h-0 overflow-hidden">
				{profiles.length === 0 ? (
					<div className="flex-1 flex flex-col items-center justify-center text-center gap-3 text-gray-400">
						<FaUsers className="text-5xl text-gray-500" />
						<p className="text-lg font-semibold text-gray-300">{t("profiles.noProfilesYet")}</p>
						<p className="text-sm">
							<Trans
								i18nKey="profiles.noProfilesHint"
								components={{ bold: <b className="text-white" /> }}
							/>
						</p>
					</div>
				) : (
					<div className="flex-1 min-h-0 overflow-auto rounded-xl">
						<Table className="bg-transparent min-w-190">
							<Table.ScrollContainer>
							<Table.Content aria-label={t("profiles.profilesAriaLabel")}>
								<Table.Header>
									<Table.Column id="name" isRowHeader>
										{t("common.name")}
									</Table.Column>
									<Table.Column id="created">{t("common.createdOn")}</Table.Column>
									<Table.Column id="actions">{t("common.actions")}</Table.Column>
								</Table.Header>
								<Table.Body>
									{profiles.map((profile) => (
										<Table.Row key={profile.name} id={profile.name}>
											<Table.Cell>
												<span className="block max-w-45 truncate">{profile.name}</span>
											</Table.Cell>
											<Table.Cell>{formatUnixMillis(profile.created)}</Table.Cell>
											<Table.Cell>
												<div className="flex flex-nowrap items-center">
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:load", "{}");
																window.Main.on("settings:profile:load", (message: string) => {
																	window.Main.removeAllListeners("settings:profile:load");
																	const rawData = JSON.parse(message);
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
																				<p className="text-sm text-gray-300 text-center mt-2">
																					{t("profiles.loadSuccessDetail")}
																				</p>
																			</div>
																		),
																		footer: (
																			<CustomButton className="w-full" color="success" onPress={closeModal}>
																				{t("common.close")}
																			</CustomButton>
																		),
																	});
																	resolve();
																});
																window.Main.send("settings:profile:load", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													{t("common.load")}
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
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
																				if (window.Main) {
																					window.Main.send("analytics:track", "profile:edit", "{}");
																					window.Main.on("settings:profile:rename", (message: string) => {
																						window.Main.removeAllListeners("settings:profile:rename");
																						const rawData = JSON.parse(message);
																						if (!rawData.success) {
																							reject(rawData.error);
																							return;
																						}
																						refreshProfiles();
																						resolve();
																						closeModal();
																					});
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
																					window.Main.send("settings:profile:rename", profile.name, input.value);
																				} else {
																					reject("No window.Main");
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
													}}
												>
													<FaEdit />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:duplicate", "{}");
																window.Main.on("settings:profile:duplicate", (message: string) => {
																	window.Main.removeAllListeners("settings:profile:duplicate");
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																		return;
																	}
																	refreshProfiles();
																	resolve();
																});
																window.Main.send("settings:profile:duplicate", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaCopy />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:view", "{}");
																window.Main.on("settings:profile:view", (message: string) => {
																	const rawData = JSON.parse(message);
																	if (rawData.error) {
																		reject(rawData.error);
																		window.Main.removeAllListeners("settings:profile:view");
																		return;
																	}
																	showModal({
																		title: `Settings — ${profile.name}`,
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
																	window.Main.removeAllListeners("settings:profile:view");
																});
																window.Main.send("settings:profile:view", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaEye />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
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
													}}
												>
													<FaCodeCompare />
												</CustomButton>
												<CustomButton
													size="sm"
													className={"mr-2"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:share", "{}");
																window.Main.on("settings:profile:share", (message: string) => {
																	window.Main.removeAllListeners("settings:profile:share");
																	const rawData = JSON.parse(message);
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
																							if (window.Main) {
																								window.Main.send("analytics:track", "profile:share:copy", "{}");
																								window.Main.send("clipboard:set", rawData.code);
																								resolve();
																							} else {
																								reject("No window.Main");
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
																});
																window.Main.send("settings:profile:share", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaShare />
												</CustomButton>
												<CustomButton
													size="sm"
													className={""}
													color={"danger"}
													onClickLoading={() => {
														return new Promise<void>((resolve, reject) => {
															if (window.Main) {
																window.Main.send("analytics:track", "profile:remove", "{}");
																window.Main.on("settings:profile:remove", (message: string) => {
																	window.Main.removeAllListeners("settings:profile:remove");
																	const rawData = JSON.parse(message);
																	if (rawData.error || !rawData.success) {
																		reject(rawData.error ?? "Failed to remove profile");
																		return;
																	}
																	refreshProfiles();
																	resolve();
																});
																window.Main.send("settings:profile:remove", profile.name);
															} else {
																reject("No window.Main");
															}
														});
													}}
												>
													<FaTrash />
												</CustomButton>
												</div>
											</Table.Cell>
										</Table.Row>
									))}
								</Table.Body>
							</Table.Content>
							</Table.ScrollContainer>
						</Table>
					</div>
				)}
			</div>
		</div>
	);
};

export default SettingsProfiles;
