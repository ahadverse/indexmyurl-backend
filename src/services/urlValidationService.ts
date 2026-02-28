import mongoose from 'mongoose';
import { isValidUrl, extractDomain } from '../utils/helpers';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { DomainActivity } from '../models/DomainActivity';

const BLOCKED_PATTERNS = [
  /\b(porn|xxx|adult|nude|naked|escort|onlyfans)\b/i,
  /\b(malware|phishing|crack|keygen|warez)\b/i,
  /\b(casino|gambling|poker|betting)\b/i,
  /\b(viagra|cialis|pharma-)\b/i,
];

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  domain?: string;
}

export class UrlValidationService {
  async validate(
    url: string,
    userId: mongoose.Types.ObjectId
  ): Promise<ValidationResult> {
    // 1. Format check
    if (!isValidUrl(url)) {
      return { isValid: false, reason: 'Invalid URL. Must start with http:// or https://' };
    }

    // 2. Blocked content check
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(url)) {
        return { isValid: false, reason: 'URL contains blocked content' };
      }
    }

    // 3. Extract domain
    let domain: string;
    try {
      domain = extractDomain(url);
    } catch {
      return { isValid: false, reason: 'Cannot extract domain from URL' };
    }

    // 4. Domain not blocked
    const domainActivity = await DomainActivity.findOne({ domain });
    if (domainActivity?.isBlocked) {
      return {
        isValid: false,
        reason: `Domain is blocked: ${domainActivity.blockedReason || 'Policy violation'}`,
      };
    }

    // 5. Check for existing active job
    const existing = await UrlJob.findOne({
      userId,
      originalUrl: url,
      status: { $nin: [JobStatus.FAILED, JobStatus.INDEXED] },
    });

    if (existing) {
      return {
        isValid: false,
        reason: `URL already submitted. Current status: ${existing.status}`,
      };
    }

    return { isValid: true, domain };
  }
}

export const urlValidationService = new UrlValidationService();
