# Nagrik on AWS with CI/CD: full guide

Goal: run Nagrik's backend on AWS (ECS Fargate) and deploy it automatically from GitHub Actions, so you can honestly write "deployed agentic AI on AWS with CI/CD" on your resume.

Time: about 2 weeks at a relaxed pace. Do the parts in order. Tick a box only when it works.

How this guide is meant to be used
- Replace everything in `<ANGLE_BRACKETS>` with your own values.
- I have not seen Nagrik's code. Ports, folder names, the build command and the health-check path are placeholders. Change them to match your repo.
- AWS screens and prices change. Check current free-tier, credit and pricing terms yourself before you start.
- Do not put the resume claims in until the matching part is live (see the last section).

Architecture you are building

```
GitHub push --> GitHub Actions: test + agent evals --> (pass) --> build Docker image
                                                          |
                                                          v
                                                   Amazon ECR (image)
                                                          |
                                                          v
Phone app --> Load balancer --> ECS Fargate (Nagrik API container)
                                    |-- reads secrets from AWS Secrets Manager
                                    |-- stores photos in S3 (via IAM task role)
                                    |-- talks to Supabase + Gemini over the internet
                                    `-- writes logs to CloudWatch
```

---

## Part 0: Before you touch AWS (30 min)

- [ ] Install: Docker Desktop, AWS CLI v2 (`aws --version`), Git.
- [ ] Create an AWS account. Turn on MFA for the root user.
- [ ] Create an IAM Identity Center user or an IAM user for yourself with admin rights. From now on, never use root.
- [ ] Configure the CLI: `aws configure sso` (preferred) or `aws configure` with that user's keys. Keep keys out of git.
- [ ] Billing: Budgets > create a monthly budget (for example 500 INR) with an email alert. Also turn on "Free tier usage alerts".
- [ ] Choose one region and use it everywhere. `ap-south-1` (Mumbai) is close to you. Run `export AWS_REGION=ap-south-1`.
- [ ] Note your account ID: `aws sts get-caller-identity --query Account --output text`.

Useful shell variables for the rest of the guide:

```bash
export AWS_REGION=ap-south-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export APP=nagrik
```

---

## Part 1: Make the app container-ready (day 1-2)

### 1.1 Dockerfile
Nagrik uses Playwright (a real browser) to file complaints, so the image must include browsers. The simplest way is the official Playwright image. Pin the version to the same version as `playwright` in your `package.json`.

```dockerfile
# Dockerfile (backend)
FROM mcr.microsoft.com/playwright:v<PLAYWRIGHT_VERSION>-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # compiles TypeScript -> dist/

ENV NODE_ENV=production
EXPOSE 3000
USER pwuser                # run as non-root (user exists in the Playwright image)
CMD ["node", "dist/index.js"]
```

- [ ] Replace `<PLAYWRIGHT_VERSION>` (for example `1.48.0`) and the entry file `dist/index.js` with your real one.
- [ ] Add a `.dockerignore` with `node_modules`, `.env`, `.git`, `dist`.
- [ ] Add a `/health` route that returns 200 quickly (no database or LLM call). The load balancer needs it.
- [ ] Read the port from `process.env.PORT || 3000`.
- [ ] Build and run locally: `docker build -t nagrik .` then `docker run --rm -p 3000:3000 --env-file .env nagrik`. Check `curl localhost:3000/health`.

Mac note: if you build on an Apple Silicon Mac, build for the server's CPU: `docker build --platform linux/amd64 -t nagrik .`. Otherwise the container may fail on Fargate with an "exec format error". (CI builds on Linux x86, so it is fine there.)

### 1.2 Keep secrets out of the image
- [ ] The app must read every secret from environment variables (Supabase URL and key, Gemini key, anything for the portal). Nothing hard-coded, nothing copied into the image.
- [ ] Confirm `.env` is in `.gitignore` and was never committed. If a key was ever committed, rotate it now.

---

## Part 2: AWS building blocks (day 2-4)

### 2.1 ECR (stores your Docker images)

```bash
aws ecr create-repository --repository-name $APP --region $AWS_REGION \
  --image-scanning-configuration scanOnPush=true
aws ecr get-login-password --region $AWS_REGION | \
  docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
docker build --platform linux/amd64 -t $APP .
docker tag $APP:latest $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP:latest
docker push $ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$APP:latest
```

- [ ] The image shows up in the ECR console.
- [ ] Optional: add a lifecycle rule to keep only the last 10 images (saves storage cost).

### 2.2 S3 bucket for complaint photos

```bash
export BUCKET=nagrik-photos-<yourname>-$ACCOUNT_ID
aws s3api create-bucket --bucket $BUCKET --region $AWS_REGION \
  --create-bucket-configuration LocationConstraint=$AWS_REGION
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

- [ ] Bucket is private. Photos are served to users through short-lived pre-signed URLs, not public links.

Code change in the backend:

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

```ts
// storage.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION }); // credentials come from the ECS task role
const Bucket = process.env.S3_BUCKET!;

export async function putPhoto(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
}
export async function photoUrl(key: string) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: 300 });
}
```

- [ ] Never create `new S3Client({ credentials: ... })` with keys. The task role supplies credentials automatically in AWS. Locally, your own `aws configure` profile is used.
- [ ] Add a unit test for this module (mock the S3 client) so CI covers it.

### 2.3 Secrets Manager (API keys)

```bash
aws secretsmanager create-secret --name nagrik/prod --region $AWS_REGION \
  --secret-string '{"GEMINI_API_KEY":"<...>","SUPABASE_URL":"<...>","SUPABASE_SERVICE_KEY":"<...>"}'
```

- [ ] Note the secret ARN printed in the output. You will reference individual keys in the task definition like `arn:aws:secretsmanager:...:secret:nagrik/prod-XXXXXX:GEMINI_API_KEY::`.
- [ ] Do not paste these values into chat, screenshots or git.

### 2.4 Two IAM roles for ECS (this is the part interviewers ask about)

1. **Task execution role** `nagrikEcsExecutionRole`: lets ECS pull the image from ECR, write logs and read the secret at start-up.
   - Attach the AWS managed policy `AmazonECSTaskExecutionRolePolicy`.
   - Add an inline policy that allows `secretsmanager:GetSecretValue` on your `nagrik/prod` secret ARN only.
   - Trust policy: service `ecs-tasks.amazonaws.com`.
2. **Task role** `nagrikTaskRole`: what your running code is allowed to do. Only S3 on one bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject"],
    "Resource": "arn:aws:s3:::<YOUR_BUCKET>/*"
  }]
}
```
   - Trust policy: service `ecs-tasks.amazonaws.com`.

- [ ] You can explain the difference: the execution role is for ECS itself, the task role is for your code.

### 2.5 CloudWatch log group

```bash
aws logs create-log-group --log-group-name /ecs/nagrik --region $AWS_REGION
aws logs put-retention-policy --log-group-name /ecs/nagrik --retention-in-days 14
```

---

## Part 3: Run it on ECS Fargate (day 4-6)

Use the console for the cluster, load balancer and service the first time. It is easier to learn.

### 3.1 Task definition
Save this as `task-definition.json` in your repo (replace the placeholders). CPU 1 vCPU / memory 2 GB is a sensible start for Playwright. Check Fargate pricing for your region before you scale it.

```json
{
  "family": "nagrik",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "1024",
  "memory": "2048",
  "executionRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/nagrikEcsExecutionRole",
  "taskRoleArn": "arn:aws:iam::<ACCOUNT_ID>:role/nagrikTaskRole",
  "containerDefinitions": [
    {
      "name": "nagrik",
      "image": "<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/nagrik:latest",
      "essential": true,
      "portMappings": [{ "containerPort": 3000, "protocol": "tcp" }],
      "environment": [
        { "name": "AWS_REGION", "value": "<REGION>" },
        { "name": "S3_BUCKET", "value": "<YOUR_BUCKET>" },
        { "name": "NODE_ENV", "value": "production" }
      ],
      "secrets": [
        { "name": "GEMINI_API_KEY", "valueFrom": "<SECRET_ARN>:GEMINI_API_KEY::" },
        { "name": "SUPABASE_URL", "valueFrom": "<SECRET_ARN>:SUPABASE_URL::" },
        { "name": "SUPABASE_SERVICE_KEY", "valueFrom": "<SECRET_ARN>:SUPABASE_SERVICE_KEY::" }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/nagrik",
          "awslogs-region": "<REGION>",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30, "timeout": 5, "retries": 3, "startPeriod": 30
      }
    }
  ]
}
```

- [ ] The health-check `curl` needs curl in the image. The Playwright image has it; if you change the base image, check.
- [ ] Register it: `aws ecs register-task-definition --cli-input-json file://task-definition.json`.

### 3.2 Cluster, load balancer, service (console)
- [ ] ECS > Clusters > create `nagrik-cluster` (Fargate).
- [ ] EC2 > Load Balancers > create an Application Load Balancer, internet-facing, in two public subnets. Target group: type IP, port 3000, health check path `/health`.
- [ ] Security groups: the load balancer allows 80/443 from anywhere. The ECS service allows port 3000 only from the load balancer's security group (not from the internet).
- [ ] ECS > cluster > Create service: Fargate, the task definition above, desired count 1, attach the load balancer and target group, public IP on (so it can reach Supabase and Gemini without a NAT gateway, which costs extra).
- [ ] Wait until the target is "healthy". Then `curl http://<ALB-DNS-NAME>/health`.
- [ ] HTTPS: request a free certificate in AWS Certificate Manager for a domain you own and add an HTTPS listener. If you have no domain yet, HTTP is fine for testing; point the mobile app at HTTPS before real users.

### 3.3 Test the whole flow
- [ ] Point a test build of the Expo app (or a curl script) at the ALB URL.
- [ ] Submit a complaint with a photo. Confirm the photo is in S3 and opens through a pre-signed URL.
- [ ] Prove least privilege: from inside the task (ECS Exec) or a throwaway script with the task role, try to read a different bucket. It must be denied. This is a great interview story.
- [ ] Look at the logs in CloudWatch.

---

## Part 4: CI/CD with GitHub Actions and OIDC (day 7-10)

OIDC means GitHub proves its identity to AWS for each run and gets short-lived credentials. No AWS keys are stored in GitHub.

### 4.1 One-time AWS setup
- [ ] IAM > Identity providers > Add provider: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
- [ ] Create a role `github-deploy-nagrik` with this trust policy (it only allows your repo's main branch):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:<GITHUB_USER>/<REPO>:ref:refs/heads/main" }
    }
  }]
}
```

- [ ] Give that role a permissions policy with only what the deploy needs:
  - ECR: `ecr:GetAuthorizationToken` (on `*`), plus `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage` on your repository.
  - ECS: `ecs:RegisterTaskDefinition`, `ecs:DescribeTaskDefinition`, `ecs:DescribeServices`, `ecs:UpdateService`.
  - `iam:PassRole` on the two ECS roles only.
- [ ] In GitHub: add a repository variable (not a secret) `AWS_ROLE_ARN` with the role's ARN. Optionally require approval on a "production" environment.

### 4.2 The workflow
`.github/workflows/deploy.yml`. Adjust the test commands to match how your repo runs tests and the 40-case eval.

```yaml
name: test-and-deploy

on:
  push:
    branches: [main]
  pull_request:

permissions:
  id-token: write   # needed for OIDC
  contents: read

env:
  AWS_REGION: ap-south-1
  ECR_REPOSITORY: nagrik
  ECS_CLUSTER: nagrik-cluster
  ECS_SERVICE: <SERVICE_NAME>
  TASK_DEFINITION: task-definition.json
  CONTAINER_NAME: nagrik

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm run build
      - run: npm test          # unit + the 39 failure-mode tests
      - run: npm run eval      # the 40-case agent eval; fails below your threshold
        env:
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}   # test key, not the prod key

  deploy:
    needs: test                # only runs if tests and eval pass
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - id: build
        run: |
          IMAGE=${{ steps.ecr.outputs.registry }}/${{ env.ECR_REPOSITORY }}:${{ github.sha }}
          docker build -t $IMAGE .
          docker push $IMAGE
          echo "image=$IMAGE" >> $GITHUB_OUTPUT

      - id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: ${{ env.TASK_DEFINITION }}
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ steps.build.outputs.image }}

      - uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.render.outputs.task-definition }}
          service: ${{ env.ECS_SERVICE }}
          cluster: ${{ env.ECS_CLUSTER }}
          wait-for-service-stability: true
```

Notes
- Each deploy uses the commit SHA as the image tag. That means you can always say exactly which code is running and roll back by redeploying an older SHA.
- Pin the GitHub Actions to the current major versions as shown, and check the actions' documentation for any changes.
- The eval step calls the Gemini API with a test key. If you worry about cost, run the full eval only on main and a smaller subset on pull requests.

- [ ] Push a small change. Watch the Actions run: tests, eval, build, deploy.
- [ ] Break a test on purpose in a branch. Confirm the deploy does not run. Take a screenshot for your README.
- [ ] Roll back once by redeploying an older image tag. Practise this before an interview.

---

## Part 5: Make it production-like (day 10-12)

- [ ] **Alarms:** CloudWatch alarms on ECS service CPU/memory and on the load balancer's 5xx count, with an email notification (SNS).
- [ ] **Agent tracing:** keep Langfuse (or add CloudWatch structured logs) so every agent run and tool call is visible. Include the trace ID in the API response logs.
- [ ] **Auto restart:** ECS restarts failed tasks by itself. Confirm by stopping a task and watching a new one start.
- [ ] **Least privilege review:** list each role and say in one sentence why every permission exists.
- [ ] **Cost note:** after a week, read Cost Explorer and write the monthly cost in the README. The load balancer and Fargate are the main costs; check current prices.
- [ ] **Optional AWS-native AI:** call a model through Amazon Bedrock from one agent, using the task role (add `bedrock:InvokeModel` for that model only). Check Bedrock model access and pricing in your region first. Keep Gemini as a fallback if Bedrock is not available to you.
- [ ] **Optional later:** define the whole setup in Terraform. It is a strong extra, but not needed for a first job.

---

## Part 6: README and portfolio proof (day 12-14)

Add to the Nagrik README:
- [ ] The architecture diagram above.
- [ ] A short "How it deploys" section: push -> tests + eval -> build -> ECR -> ECS.
- [ ] The IAM policies (with account IDs removed) and why they are minimal.
- [ ] A screenshot of a green Actions run and one blocked run.
- [ ] The live health-check URL if you want to keep it running, and a note about cost.

---

## Clean-up (when you are done testing)

To avoid a surprise bill, delete in this order: ECS service (set desired count 0, then delete), cluster, load balancer and target group, ECR images, S3 test photos, the secret (schedule deletion), the log group. Check Cost Explorer the next day.

---

## Resume lines: add only after each part is live

After Parts 2-3:
- Deployed the Nagrik agent API as a Docker container on AWS ECS Fargate, with photos in S3, API keys in Secrets Manager and least-privilege IAM roles; logs and alarms in CloudWatch.

After Part 4:
- Built a GitHub Actions pipeline in which unit tests and the 40-case agent eval gate automatic deploys to AWS (OIDC, no stored keys), with rollback by image tag.

Skills line, once live:
- Cloud & DevOps: AWS (ECS Fargate, ECR, S3, IAM, Secrets Manager, CloudWatch), Docker, GitHub Actions (CI/CD, OIDC), Vercel, Render.

Do not add these lines early. A recruiter or interviewer will ask how you set them up.

---

## Interview questions you should be able to answer after this

1. Why Fargate and not a plain EC2 server?
2. What is the difference between the ECS task execution role and the task role?
3. Why OIDC instead of storing AWS keys in GitHub?
4. How do you stop a bad prompt or model change from reaching users? (The eval step gates the deploy.)
5. Where are the secrets stored, and who can read them?
6. A deploy breaks production. How do you roll back? (Redeploy the previous image SHA.)
7. What does this cost per month, and how do you control it?
8. How would you scale it? (More tasks behind the load balancer, queue the Playwright jobs, autoscaling on CPU or queue depth.)
9. How do you see what an agent did in a failed request? (Tracing and logs with a trace ID.)

---

## Master checklist

- [ ] Part 0: account safety, billing alert
- [ ] Part 1: Dockerfile, /health, runs locally
- [ ] Part 2: ECR, S3 + code, Secrets Manager, two IAM roles, log group
- [ ] Part 3: task definition, cluster, load balancer, service healthy, end-to-end test
- [ ] Part 4: OIDC role, workflow, one green deploy, one blocked deploy, one rollback
- [ ] Part 5: alarms, tracing, cost note
- [ ] Part 6: README with diagram and screenshots
- [ ] Resume updated, only with what is live
- [ ] Then: deploy Haathi on Cloud Run with `haathi-gcp-deployment-guide.md` for a second cloud
