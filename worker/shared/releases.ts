/** Release wire contracts (issue #54) shared by the browser and Worker. */

export interface ReleaseAsset {
  id: string;
  name: string;
  content_type: string;
  size: number;
  /** Hex SHA-256 computed on upload; every download is checked against it. */
  sha256: string;
  uploaded_by: string;
  created_at: number;
}

export interface ReleaseAttestationSummary {
  id: string;
  run_id: string;
  key_id: string;
  /** Asset names and digests the statement covers. */
  subjects: { name: string; digest: { sha256: string } }[];
  created_by: string;
  created_at: number;
}

export interface Release {
  id: string;
  tag: string;
  target_cs: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  /** The newest published release that is not a prerelease. */
  latest: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  assets: ReleaseAsset[];
  attestations: ReleaseAttestationSummary[];
}

export interface GeneratedNotes {
  name: string;
  body: string;
  previous_tag: string | null;
  changesets: number;
  pulls: number[];
}
