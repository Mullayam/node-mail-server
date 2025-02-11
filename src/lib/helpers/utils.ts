import * as crypto from "crypto";
import moment from "moment";
import { join } from "path";

export let Tokens = new Map();
export let BlacklistedTokens: string[] = [];
export const SetAppRoutes = new Map();
type Units = "d" | "h" | "m" | "w";
export type TTL = `${number}${Units}`;
class Utils {
	ParseTTL(ttl: TTL | number): number {
		if (typeof ttl === "number") {
			return ttl;
		}

		const timeUnits: { [key: string]: number } = {
			d: 86400,
			h: 3600,
			m: 60,
			w: 604800,
		};

		const regex = /^(\d+)([dhmw])$/i; // Regex to capture number and unit
		const match = ttl.match(regex);

		if (match) {
			const value = Number.parseInt(match[1], 10); // Extract number part
			const unit = match[2].toLowerCase(); // Extract unit (d, h, m, w)

			if (timeUnits[unit]) {
				return value * timeUnits[unit]; // Convert to seconds
			}
		}

		return 60;
	}
	CreatePath = (currentPath: string) => {
		const currentPathArray = currentPath.split("/");
		return join(process.cwd(), ...currentPathArray);
	};
	RandomToken(length: number = 64): string {
		return crypto.randomBytes(length).toString("hex");
	}
	/**
	 * Generates a random number within a specified range.
	 *
	 * @param {number} min - The minimum value of the range (default: 100000).
	 * @param {number} max - The maximum value of the range (default: 999999).
	 * @return {number} - The randomly generated number.
	 */
	RandomNumber(min: number = 100000, max: number = 999999): number {
		return Math.floor(Math.random() * (max - min + 1) + min);
	}
	/**
	 * Generates a unique user ID.
	 *
	 * @return {string} The generated user ID.
	 */
	CreateUserID(): string {
		const id = Math.floor(Math.random() * 10000000).toString();
		return id;
	}
	/**
	 * Generates a token of random bytes with the specified byte length.
	 *
	 * @param {number} byteLength - The length of the token in bytes. Defaults to 48.
	 * @return {string} - The generated token as a base64-encoded string.
	 */
	GenerateToken(byteLength: number = 48): string {
		return crypto.randomBytes(byteLength).toString("base64");
	}
	/**
	 * Generates a refresh token of a specified length.
	 *
	 * @param {number} byteLength - The length of the refresh token in bytes. Defaults to 32.
	 * @return {string} - The generated refresh token.
	 */
	CreateRefreshToken(byteLength: number = 32): string {
		return crypto.randomBytes(byteLength).toString("base64");
	}
	/**
	 * Generates a random request ID with the specified byte length.
	 *
	 * @param {number} byteLength - The length of the byte array used to generate the request ID. Defaults to 16.
	 * @return {string} - The generated request ID as a base64 encoded string.
	 */
	RequestId(byteLength: number = 16): string {
		return crypto.randomBytes(byteLength).toString("base64");
	}
	/**
	 * Generates a new refresh token for the given ID and stores it in the Tokens map.
	 *
	 * @param {string} id - The ID of the user for whom the refresh token is generated.
	 * @return {string} - The newly generated refresh token.
	 */
	HandleRefreshToken(id: string): string {
		const RefreshToken = this.CreateRefreshToken();
		Tokens.set(id, RefreshToken);
		return RefreshToken;
	}
	/**
	 * Converts a string to a number.
	 *
	 *
	 * @return {number} The converted number.
	 */
	CreateOTP(min: number = 100000, max: number = 999999): number {
		return Math.floor(Math.random() * (max - min + 1) + min);
	}
	/**
	 * Converts a query string to an object.
	 *
	 * @param {string} query - The query string to convert.
	 * @return {object} The resulting object.
	 */
	QueryToObject(query: string): object {
		let NewObject = {};
		query.split("&").map((item) => {
			const [key, value] = item.split("=");
			Object.assign(NewObject, Object.fromEntries([[key, value]]));
			return Object.fromEntries([[key, value]]);
		});

		return NewObject;
	}
	ObjectToQuery(obj: Record<string, string | object>): string {
		return Object.entries(obj)
			.map(([key, value]) => {
				if (typeof value === "object") {
					return `${key}=${JSON.stringify(value)}`;
				}
				return `${key}=${value}`;
			})
			.join("&");
	}
	/**
	 * Converts a string representation of a date word into a formatted date string.
	 *
	 * @param {string} str - The string representation of the date word.
	 * @return {string} - The formatted date string.
	 */
	ConvertDateWordsToDate(str: string): string {
		let newDate;
		if (str === "Latest") {
			newDate = moment().subtract(10, "minutes").toDate();
		} else if (str === "LastHour") {
			newDate = moment().subtract(1, "hour").toDate();
		} else if (str === "Last24hour") {
			newDate = moment().subtract(24, "hour").toDate();
		} else {
			const number = str.replace(/[^0-9]/g, "");
			newDate = moment().subtract(number, `days`).toDate();
		}

		const date = this.SimpleDateStr(newDate);
		return date;
	}
	/**
	 * Generates a string representation of a date.
	 *
	 * @param {Date} newDate - The date to convert to a string. Defaults to the current date.
	 * @return {string} The string representation of the date.
	 */
	SimpleDateStr(newDate: Date = new Date()): string {
		const newDateStr = newDate.toISOString().split("T");
		const date = (newDateStr[0] + " " + newDateStr[1].split(".")[0])
			.trim()
			.toString();

		return date;
	}
	/**
	 * Cleans and purifies a string by converting it to lowercase, removing leading and trailing whitespace,
	 * removing all spaces, replacing multiple spaces or underscores with a single hyphen,
	 * and removing leading and trailing hyphens.
	 *
	 * @param {string} str - The string to be purified.
	 * @return {string} The purified string.
	 */
	PurifyString(str: string): string {
		return str
			.toLowerCase()
			.trim()
			.replace(/\s/g, "")
			.replace(/[\s_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}
	/**
	 * Generates the keys and values of an object.
	 *
	 * @param {string} obj - the object to generate keys and values for
	 * @return {string[]} an array containing the keys and values of the object
	 */
	ObjectKeysAndValues(obj: string): string[] {
		let keys = Object.keys(JSON.parse(obj));
		const PureObject = keys.map((key) => {
			return JSON.parse(JSON.parse(obj)[key]);
		});
		return PureObject;
	}
	/**
	 * Formats the salary to a string with comma-separated thousands and no decimal places.
	 *
	 * @param {number} salary - The salary to be formatted.
	 * @return {string} - The formatted salary as a string.
	 */
	IndianNumberFormat(salary: number): string {
		return salary.toLocaleString("en-IN", { maximumFractionDigits: 0 });
	}

	/**
	 * Slugify a given string.
	 *
	 * @param {string} str - The string to be slugified.
	 * @return {string} The slugified string.
	 */
	Slugify(str: string): string {
		return str
			.toLowerCase()
			.trim()
			.replace(/[^\w\s-]/g, "")
			.replace(/[\s_-]+/g, "-")
			.replace(/^-+|-+$/g, "");
	}
	uuid_v4() {
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
			/[xy]/g,
			function (c) {
				var r = (Math.random() * 16) | 0,
					v = c == "x" ? r : (r & 0x3) | 0x8;
				return v.toString(16);
			},
		);
	}
	Md5Checksum(content: string): string {
		return crypto.createHash("md5").update(content).digest("hex");
	}

	SimpleHash(): string {
		return crypto.randomBytes(32).toString("hex");
	}
}
export default new Utils();
