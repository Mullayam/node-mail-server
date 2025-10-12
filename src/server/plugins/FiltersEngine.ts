interface Email {
    id: string;
    from: string;
    to: string;
    subject: string;
    body: string;
    headers: Record<string, string>;
}

interface MailFilter {
    matchType: "subject" | "sender" | "body" | "header";
    matchValue: string;
    action: "move" | "delete" | "forward" | "flag";
    targetFolder?: string;
}

interface UserSettings {
    userId: string;
    filters: MailFilter[];
}

export class FiltersEngine {
    async applyFilters(email: Email, settings: UserSettings) {
        for (const filter of settings.filters) {
            if (this.matchFilter(email, filter)) {
                console.log(`[FiltersEngine] Filter matched: ${filter.matchType} ${filter.matchValue}`);
                await this.applyAction(email, filter);
                break; // Optional: first match wins
            }
        }
    }

    private matchFilter(email: Email, filter: MailFilter): boolean {
        const target = this.extractTarget(email, filter.matchType);
        return target.includes(filter.matchValue);
    }

    private extractTarget(email: Email, type: MailFilter["matchType"]): string {
        switch (type) {
            case "subject":
                return email.subject;
            case "sender":
                return email.from;
            case "body":
                return email.body;
            case "header":
                return Object.entries(email.headers).map(([k, v]) => `${k}: ${v}`).join("\n");
            default:
                return "";
        }
    }

    private async applyAction(email: Email, filter: MailFilter) {
        switch (filter.action) {
            case "move":
                console.log(`[FiltersEngine] Moving email to folder ${filter.targetFolder}`);
                // Move email to another folder in database
                break;
            case "delete":
                console.log(`[FiltersEngine] Deleting email.`);
                // Delete email
                break;
            case "forward":
                console.log(`[FiltersEngine] Forwarding email again.`);
                // Forward email again if needed
                break;
            case "flag":
                console.log(`[FiltersEngine] Flagging email.`);
                // Set flag in database
                break;
        }
    }
}