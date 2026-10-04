import { useState } from "react";

/** Card art lives at a fixed CDN path, so avatars need no API lookup and use the browser image cache. */
export const playerCardSmallArt = (cardId?: string | null) =>
	cardId ? `https://media.valorant-api.com/playercards/${cardId.toLowerCase()}/smallart.png` : null;

/** Player card art, falling back to the name's initial when absent or unreachable. */
export const PlayerCardAvatar = ({
	cardId,
	name,
	className = "size-8",
}: {
	cardId?: string | null;
	name: string;
	className?: string;
}) => {
	const src = playerCardSmallArt(cardId);
	const [failedSrc, setFailedSrc] = useState<string | null>(null);
	if (src && failedSrc !== src) {
		return (
			<img
				src={src}
				alt=""
				loading="lazy"
				onError={() => setFailedSrc(src)}
				className={`${className} shrink-0 rounded-[6px] bg-(--control) object-cover`}
			/>
		);
	}
	return (
		<span
			aria-hidden="true"
			className={`${className} grid shrink-0 place-items-center rounded-[6px] bg-(--control) text-[11px] font-medium text-(--text-secondary)`}
		>
			{((name.split("#")[0]?.trim() || name.trim())[0] ?? "?").toUpperCase()}
		</span>
	);
};
