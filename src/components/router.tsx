import React, { createContext, Key, useContext, useEffect, useState } from "react";
import { Tabs } from "@heroui/react";
import { Route } from "@/types/router";
import RiotStatusBar from "@/components/riot-status-bar";
import { useTranslation } from "react-i18next";
import { navbarLayout } from "@/components/navbar-layout";

type RouterProps = {
	routes: Route[];
};
// Create a context to store the routes
const RouterContext = createContext<RouterProps>({ routes: [] });
// Custom hook to use the router context
const useRouter = () => {
	const routerContext = useContext(RouterContext);

	if (!routerContext) {
		throw new Error("useRouter must be used within a RouterProvider");
	}

	const [selected, setSelected] = useState<number>(0);
	const [selectedId, setSelectedId] = useState<string>(routerContext.routes[0]?.id || "");
	const [body, setBody] = useState<React.ReactNode>();

	useEffect(() => {
		setBody(routerContext.routes[selected].component);
	}, [routerContext.routes, selected]);

	const goTo = (id: string) => {
		const routeIndex = routerContext.routes.findIndex((route) => route.id === id);
		if (routeIndex !== -1) {
			console.log(`Going to route with id "${id}"`);
			setSelected(routeIndex);
			setSelectedId(id);
		} else {
			console.error(`Route with id "${id}" not found.`);
		}
	};

	const goToIndex = (index: number) => {
		// TODO: figure out why these don't work
		if (index < routerContext.routes.length) {
			console.log(`Going to route with index "${index}"`);
			setSelected(index);
			setBody(routerContext.routes[index].component);
		} else {
			console.error(`Route with index "${index}" not found.`);
		}
	};

	return { selected, selectedId, body, goTo, goToIndex };
};
const RouterProvider: React.FC<
	RouterProps & {
		children: React.ReactNode | React.ReactNode[];
	}
> = ({ routes, children }) => {
	return <RouterContext.Provider value={{ routes }}>{children}</RouterContext.Provider>;
};

const Router = () => {
	const { routes } = useContext(RouterContext);
	const { selectedId, body, goTo } = useRouter();
	const { t } = useTranslation();

	return (
		<>
			<div className={navbarLayout.root}>
				<div className={navbarLayout.tabsViewport}>
				<Tabs
					variant="secondary"
					selectedKey={selectedId}
					onSelectionChange={(key: Key) => {
						const routeId = key as string;
						goTo(routeId);
						window.Main.send(
							"analytics:track",
							"tab_change",
							JSON.stringify({
								tab: routeId,
							})
						);
					}}
				>
					<Tabs.ListContainer>
						<Tabs.List
							aria-label="Options"
							className={navbarLayout.tabsList}
						>
							{routes.map((route) => (
								<Tabs.Tab key={route.id} id={route.id} className={navbarLayout.tab}>
									<div className="flex items-center space-x-2">
										{route.icon}
										<span>{t(route.title)}</span>
									</div>
									<Tabs.Indicator className="w-full bg-[#22d3ee]!" />
								</Tabs.Tab>
							))}
						</Tabs.List>
					</Tabs.ListContainer>
				</Tabs>
				</div>
				<div className={navbarLayout.status}>
					<RiotStatusBar />
				</div>
			</div>
			<div className="flex-1 overflow-y-auto">{body}</div>
		</>
	);
};

export { Router, RouterProvider, useRouter };
