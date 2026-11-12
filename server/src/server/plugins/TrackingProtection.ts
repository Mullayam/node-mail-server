import cheerio from 'cheerio';
import qp from "quoted-printable";

export class EmailPrivacyProtector {
  private proxyBaseUrl: string;
  private trackersFound: number = 0; // Trackers detected in each email
  static suspiciousTagRegex = /<img\s*\/?>|<img[^>]*>[\s\S]*?<\/img>|<iframe[^>]*>[\s\S]*?<\/iframe>|<iframe\s*\/?>|<embed\s*\/?>|<embed[^>]*>[\s\S]*?<\/embed>/gi;
  static suspiciousAttributes = [
    'width=["\']?1px["\']?',
    'height=["\']?1px["\']?',
    'max-width=["\']?1px["\']?',
    'max-height=["\']?1px["\']?',
    'display=["\']?none["\']?',
    'visibility=["\']?hidden["\']?',
    'opacity=["\']?0["\']?',
  ];
  static suspiciousStyles = [
    'width:1px',
    'height:1px',
    'max-width:1px',
    'max-height:1px',
    'display:none',
    'visibility:hidden',
    'opacity:0',
  ];


  static paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'tk', 'dclid'];

  constructor(proxyBaseUrl: string) {
    this.proxyBaseUrl = proxyBaseUrl;
    // Check if proxyBaseUrl  server is running or not
    this.isProxyServerRunning();
  }
  private isProxyServerRunning() {
    try {
      return fetch(this.proxyBaseUrl).then((res) => res.ok).catch(() => false);
    } catch {
      throw new Error("Proxy server is not running")
    }

  }
  private static cleanHrefParams(chunks: string): string {
    return chunks.replace(/href=["']([^"']+)["']/gi, (match, hrefValue) => {
      try {
        const url = new URL(hrefValue);
        EmailPrivacyProtector.paramsToRemove.forEach(param => {
          url.searchParams.delete(param);
        });

        // Return cleaned href
        return `href="${url.origin + url.pathname + (url.search ? url.search : '') + (url.hash || '')}"`;
      } catch (err) {
        // If it's not a valid URL (e.g. mailto: or relative), leave it unchanged
        return match;
      }
    });
  }

  public async proctectEmailBody(chunks: string, tracker_sppofing: boolean = false) {
    let mailchunks = qp.decode(chunks).toString();

    const stylePattern = EmailPrivacyProtector.suspiciousStyles.map(s => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');

    const attrPattern = EmailPrivacyProtector.suspiciousAttributes.join('|');

    const tagRegex = new RegExp(
      `<(img|iframe|embed)([^>]*?)(?:style=["'][^"']*(${stylePattern})[^"']*["']|\\s(${attrPattern})=["']?1px["']?)[^>]*?(\\/?>)([\\s\\S]*?)?(<\\/\\1>)?`,
      'gi'
    );

    this.trackersFound = 0;
    let trackerSources: string[] = [];
    mailchunks = mailchunks.replace(tagRegex, (fullMatch:any) => {
      // Extract src attribute from full tag
      const srcMatch = fullMatch.match(/src=["']([^"']+)["']/i);
      if (srcMatch) {
        this.trackersFound++;
        trackerSources.push(srcMatch[1]);
      }

      return fullMatch.replace(/\s*src=["'][^"']*["']/i, '');
    });
    // send image to proxy server
    if (tracker_sppofing) {
      const protector = new EmailPrivacyProtector(this.proxyBaseUrl);
      trackerSources.forEach((v) => {
        protector.getProxiedImageUrl(v)
      })
    }
    return {
      cleanedEmail: EmailPrivacyProtector.cleanHrefParams(mailchunks),
      trackersDetected: this.trackersFound
    };
  }
  /**
   * Main function to process the email body:
   *  - Remove spy pixels
   *  - Proxy normal images
   *  - Count trackers detected
   */
  public async protectHTMLBody(html: string): Promise<{ cleanedHtml: string; trackersDetected: number }> {
    const $ = cheerio.load(html);

    this.trackersFound = 0; // reset count

    // Protect <img> tags
    $('img').each((_, el) => this.processElement($, el, 'img'));

    // Also protect <iframe>, <object>, <embed>
    $('iframe, object, embed').each((_, el) => this.processElement($, el));

    // Clean the links (remove UTM parameters, etc.)
    this.cleanLinks($);

    return {
      cleanedHtml: $.html(),
      trackersDetected: this.trackersFound
    };
  }

  /**
   * Process and clean a suspicious element
   */
  private processElement($: cheerio.CheerioAPI, el: any, tagName?: string) {
    const $el = $(el);
    const src = $el.attr('src') || $el.attr('data') || '';
    const width = $el.attr('width');
    const height = $el.attr('height');
    const style = ($el.attr('style') || '').toLowerCase();

    if (this.isTrackingPixel(width, height, style)) {
      console.log(`Removed potential spy pixel (${el.tagName}): ${src}`);
      $el.remove();
      this.trackersFound++;
    } else if (tagName === 'img' && src) {
      // Only proxy real <img> tags, not iframe/object
      const proxiedSrc = this.getProxiedImageUrl(src);
      $el.attr('src', proxiedSrc);
    }
  }

  /**
   * Check if an element is likely a tracking pixel
   */
  private isTrackingPixel(width?: string, height?: string, style?: string): boolean {
    const isPixelBySize = (width === '1' && height === '1');
    const isPixelByStyle = !!style && (
      style.includes('width:1px') ||
      style.includes('height:1px') ||
      style.includes('max-width:1px') ||
      style.includes('max-height:1px') ||
      style.includes('display:none') ||
      style.includes('visibility:hidden') ||
      style.includes('opacity:0')
    );
    return isPixelBySize || isPixelByStyle;
  }

  /**
   * Get the proxied URL for an image
   */
  getProxiedImageUrl(originalUrl: string): string {
    return `${this.proxyBaseUrl}/proxy?url=${encodeURIComponent(originalUrl)}`;
  }

  /**
   * Clean URLs by removing tracking parameters like utm_* and other query params
   */
  private cleanLinks($: cheerio.CheerioAPI) {
    $('a').each((_, el) => {
      const $el = $(el);
      const href = $el.attr('href') || '';
      if (href) {
        const cleanedHref = this.removeTrackingParams(href);
        if (cleanedHref !== href) {
          console.log(`Cleaned link: ${href} -> ${cleanedHref}`);
          $el.attr('href', cleanedHref);
        }
      }
    });
  }

  /**
   * Remove common tracking parameters from a URL
   */
  private removeTrackingParams(url: string): string {
    const urlObj = new URL(url);
    const paramsToRemove = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'tk', 'dclid'];

    // Remove any unwanted query parameters
    paramsToRemove.forEach(param => urlObj.searchParams.delete(param));

    return urlObj.toString();
  }
}
