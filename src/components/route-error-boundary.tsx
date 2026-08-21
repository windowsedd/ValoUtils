import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
	children: ReactNode;
	label?: string;
};

type State = {
	error: Error | null;
};

export class RouteErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error(`[ValoUtils] ${this.props.label ?? "route"} crashed`, error, info.componentStack);
	}

	render() {
		if (!this.state.error) return this.props.children;
		return (
			<div className="flex h-full items-center justify-center p-6">
				<div className="max-w-lg rounded-2xl border border-red-400/20 bg-red-400/5 p-6 text-center">
					<p className="font-semibold text-white">This page crashed.</p>
					<p className="mt-2 text-sm text-gray-400">{this.state.error.message}</p>
					<button
						type="button"
						className="mt-4 h-11 rounded-lg border border-white/15 bg-white/8 px-4 text-sm font-semibold text-white hover:bg-white/12"
						onClick={() => this.setState({ error: null })}
					>
						Retry
					</button>
				</div>
			</div>
		);
	}
}
