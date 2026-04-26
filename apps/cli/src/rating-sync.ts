import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs';
import {
  findOrCreateGist,
  pullFromGist,
  pushToGist,
  mergeRatings,
  type GistContent,
} from '@agentoctopus/registry';
import type { RatingEntry, RatingsStore } from '@agentoctopus/registry';
import { loadConfig, saveConfigFile, getConfigPath } from '@agentoctopus/core';

export interface RatingSyncOptions {
  pull?: boolean;
  push?: boolean;
  force?: boolean;
  dryRun?: boolean;
  setupGist?: boolean;
  noFeedbackSharing?: boolean;
}

export async function runRatingSync(options: RatingSyncOptions): Promise<void> {
  const config = loadConfig();

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    console.error(chalk.red('GITHUB_TOKEN not set. Set it in your environment or .env file.'));
    return;
  }

  // Setup gist
  if (options.setupGist) {
    const spinner = ora('Setting up GitHub Gist for rating sync...').start();
    try {
      const gistId = await findOrCreateGist(githubToken);
      const octoPath = getConfigPath();
      const raw = fs.existsSync(octoPath) ? JSON.parse(fs.readFileSync(octoPath, 'utf8')) : { version: 2 };
      raw.rating = { ...(raw.rating || {}), gistId };
      saveConfigFile(raw);
      spinner.succeed(`Gist setup complete. ID: ${gistId}`);
    } catch (err) {
      spinner.fail(`Gist setup failed: ${(err as Error).message}`);
    }
    return;
  }

  if (!config.rating.gistId) {
    console.error(chalk.red('No gist ID configured. Run `octopus sync --setup-gist` first.'));
    return;
  }

  // Load local ratings
  const localRatings: RatingsStore = fs.existsSync(config.registry.ratingsPath)
    ? JSON.parse(fs.readFileSync(config.registry.ratingsPath, 'utf-8'))
    : {};

  // Pull
  if (options.pull || (!options.push && !options.pull)) {
    const spinner = ora('Pulling ratings from GitHub Gist...').start();
    try {
      const cloudContent = await pullFromGist(config.rating.gistId, githubToken);
      const cloudRatings = cloudContent.ratings;

      if (options.force) {
        if (options.dryRun) {
          spinner.info('Dry run: would overwrite local ratings with cloud data');
          printDiff(localRatings, cloudRatings);
        } else {
          fs.writeFileSync(config.registry.ratingsPath, JSON.stringify(cloudRatings, null, 2), 'utf-8');
          spinner.succeed('Overwrote local ratings with cloud data (force pull)');
        }
      } else {
        const merged: RatingsStore = {};
        const allSkills = new Set([
          ...Object.keys(localRatings),
          ...Object.keys(cloudRatings),
        ]);

        let updated = 0;
        for (const skillName of allSkills) {
          const local = localRatings[skillName] as RatingEntry | undefined;
          const cloud = cloudRatings[skillName] as RatingEntry | undefined;
          if (cloud && !local) {
            merged[skillName] = cloud;
            updated++;
          } else if (local && cloud) {
            merged[skillName] = mergeRatings(local, cloud);
            updated++;
          } else {
            merged[skillName] = local!;
          }
        }

        if (options.dryRun) {
          spinner.info('Dry run: would merge ratings from cloud');
          printDiff(localRatings, merged);
        } else {
          fs.writeFileSync(config.registry.ratingsPath, JSON.stringify(merged, null, 2), 'utf-8');
          spinner.succeed(`Synced ${allSkills.size} skills. ${updated} updated from cloud.`);
        }
      }
    } catch (err) {
      spinner.fail(`Pull failed: ${(err as Error).message}`);
      return;
    }
  }

  // Push
  if (options.push || (!options.push && !options.pull)) {
    const spinner = ora('Pushing ratings to GitHub Gist...').start();
    try {
      const currentRatings: RatingsStore = JSON.parse(
        fs.readFileSync(config.registry.ratingsPath, 'utf-8'),
      );
      const feedbackLog: Record<string, any> = {};

      if (!options.noFeedbackSharing) {
        for (const [name, entry] of Object.entries(currentRatings)) {
          if ((entry as RatingEntry).recentFeedback?.length > 0) {
            feedbackLog[name] = (entry as RatingEntry).recentFeedback;
          }
        }
      }

      const content: GistContent = {
        ratings: currentRatings,
        feedbackLog,
        syncMeta: {
          lastSyncTimestamp: new Date().toISOString(),
          version: 1,
          userId: '',
        },
      };

      if (!options.dryRun) {
        await pushToGist(config.rating.gistId, githubToken, content);
        spinner.succeed('Pushed ratings to GitHub Gist');
      } else {
        spinner.info('Dry run: would push ratings to GitHub Gist');
      }
    } catch (err) {
      spinner.fail(`Push failed: ${(err as Error).message}`);
    }
  }
}

function printDiff(local: RatingsStore, remote: RatingsStore): void {
  for (const [name, entry] of Object.entries(remote)) {
    const localEntry = local[name] as RatingEntry | undefined;
    const remoteEntry = entry as RatingEntry;
    if (!localEntry) {
      console.log(chalk.cyan(`  ${name}:`), 'new from cloud');
    } else if (localEntry.dimensions.quality !== remoteEntry.dimensions.quality) {
      console.log(
        chalk.cyan(`  ${name}:`),
        `quality ${localEntry.dimensions.quality.toFixed(1)} → ${remoteEntry.dimensions.quality.toFixed(1)}`,
      );
    }
  }
}
