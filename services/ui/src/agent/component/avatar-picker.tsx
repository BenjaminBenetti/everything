import { useId, useState } from "react";
import { Search } from "lucide-react";
import type { AgentAvatarId } from "@everything/agent-contracts/avatar";
import { ChoiceCard } from "@everything/ui/choice-card";
import { TeammateAvatar } from "./teammate-avatar.js";
import {
  avatarCategories,
  teammateAvatars,
} from "../model/teammate-avatars.js";

/** Filter a fixed artwork catalog with accessible, keyboard-operated selection cards. */
export function AvatarPicker({
  value,
  onChange,
}: {
  value: AgentAvatarId;
  onChange: (avatarId: AgentAvatarId) => void;
}) {
  const name = useId();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const matches = teammateAvatars.filter(
    (avatar) =>
      (category === "all" || avatar.category === category) &&
      avatar.name
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <div className="avatar-picker">
      <label className="search avatar-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Search avatars</span>
        <input
          autoFocus
          type="search"
          placeholder="Find an avatar…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <div
        className="avatar-categories"
        role="group"
        aria-label="Avatar categories"
      >
        {[{ id: "all", label: "All" }, ...avatarCategories].map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={category === item.id}
            onClick={() => setCategory(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <fieldset className="avatar-grid" aria-label="Teammate avatar">
        {matches.map((avatar) => (
          <ChoiceCard
            key={avatar.id}
            className="avatar-choice"
            name={name}
            value={avatar.id}
            label={avatar.name}
            checked={value === avatar.id}
            onChange={() => onChange(avatar.id)}
          >
            <TeammateAvatar avatarId={avatar.id} />
          </ChoiceCard>
        ))}
      </fieldset>
      <p className="avatar-result-count" role="status">
        {matches.length === 0
          ? "No matching avatars. Try another name or category."
          : `${matches.length} ${matches.length === 1 ? "avatar" : "avatars"}`}
      </p>
    </div>
  );
}
